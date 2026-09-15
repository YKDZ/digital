import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, constants as sqliteConstants } from "node:sqlite";
import { promisify } from "node:util";

import type {
  AutomationClock,
  ChangeImpactPreview,
  MetadataPolicyConfiguration,
  MetadataRefreshPersistence,
  ObservedRootRegistration,
  RecoverySourceRefreshRunCommands,
  SourceRefreshRunPersistence,
  WorkflowConfigurationCompatibility,
  WorkflowExecution,
} from "@digital/application";
import {
  AssetRefreshAutomation,
  type AssetRefreshAutomationWorkflow,
  AssetRefreshWorkflow,
  AutomationHost,
  ExecutionHost,
  ObservedRootRegistrations,
  attachAssetRefreshAutomation,
  sha256,
  artifactProofConditionalBaseline,
} from "@digital/application";
import { DlsiteSourceInterpreter } from "@digital/dlsite";
import type {
  AcceptedRecognition,
  SourceAssociationChangeProposal,
  SourceAssociationDecision,
  SourceRecord,
} from "@digital/domain";
import { FanboxDateDirectoryInterpreter } from "@digital/fanbox";
import { createScriptedFanboxProductAssembly } from "@digital/fanbox/testing";
import { ReadOnlyFilesystemObserver } from "@digital/filesystem";
import { SqliteCatalogue, type SqliteCatalogueOptions } from "@digital/sqlite";
import {
  inspectSqliteSchema,
  isPreparedCatalogue,
  prepareDisposableCatalogue,
  prepareDisposableProductDataCatalogue,
} from "@digital/sqlite/testing";
import {
  InMemoryObservedFilesystemCapability,
  InMemoryObservedRootCleanupReporter,
  InMemoryObservedRootRegistrationStore,
  type InMemoryObservedFilesystemOptions,
} from "@digital/test-support";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  composeAssetRefresh,
  composeOwnedAutomationHost,
} from "../src/runtime.ts";
import {
  disposePreparedCatalogueTemplate,
  prepareWithFormalMigration,
  preparedCatalogueRoot,
} from "./prepared-catalogue.ts";

const cleanup: string[] = [];
const execFileAsync = promisify(execFile);

function collectObservedRootCleanupFailure(): {
  readonly cleanupFailures: unknown[];
  readonly reporter: {
    reportCleanupFailure(input: unknown): void;
    reportCleanupReportingFailure(input: unknown): void;
  };
} {
  const cleanupFailures: unknown[] = [];
  return {
    cleanupFailures,
    reporter: {
      reportCleanupFailure(input) {
        cleanupFailures.push(input);
      },
      reportCleanupReportingFailure(input) {
        cleanupFailures.push(input);
      },
    },
  };
}

it("serializes real SQLite proof CAS without allowing a later completion to overwrite coordinates", async () => {
  const { root, catalogue: first } = await createCatalogueWithRoot();
  const second = SqliteCatalogue.forProductData(root);
  const digest = "a".repeat(64);
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  database.exec(`
    INSERT INTO artifacts (id) VALUES ('artifact-proof-cas');
    INSERT INTO blobs (digest, media_type, byte_length)
      VALUES ('${digest}', 'application/octet-stream', 3);
    INSERT INTO artifact_revisions (id, artifact_id, blob_digest)
      VALUES ('revision-proof-cas', 'artifact-proof-cas', '${digest}');
    INSERT INTO locations (id, artifact_id, address, kind)
      VALUES ('location-proof-cas', 'artifact-proof-cas', '/managed/${digest}', 'managed');
  `);
  database.close();
  const expected = {
    revisionId: "revision-proof-cas",
    artifactId: "artifact-proof-cas",
    blobDigest: digest,
    blobByteLength: 3,
    locationId: "location-proof-cas",
    locationKind: "managed" as const,
    conditionalBaseline: artifactProofConditionalBaseline({
      revisionId: "revision-proof-cas",
      artifactId: "artifact-proof-cas",
      blobDigest: digest,
      blobByteLength: 3,
      locationId: "location-proof-cas",
      locationKind: "managed",
    }),
  };
  const proof = {
    blobDigest: digest,
    scheme: "artifact-frame-manifest/1" as const,
    byteLength: 3,
    frameSize: 1_048_576 as const,
    frameCount: 1,
    manifestDigest: "b".repeat(64),
  };

  expect(
    (
      await Promise.all([
        first.adoptArtifactContentProof({ expected, proof }),
        second.adoptArtifactContentProof({ expected, proof }),
      ])
    ).toSorted(),
  ).toEqual(["already-committed", "committed"]);
  await expect(
    second.adoptArtifactContentProof({
      expected,
      proof: { ...proof, manifestDigest: "c".repeat(64) },
    }),
  ).resolves.toBe("stale");
  await expect(
    first.adoptArtifactContentProof({
      expected: {
        ...expected,
        locationId: "different-location",
        conditionalBaseline: artifactProofConditionalBaseline({
          ...expected,
          locationId: "different-location",
        }),
      },
      proof,
    }),
  ).resolves.toBe("stale");
  first.close();
  second.close();
});

it("confirms one current revision at multiple observed Locations without re-offering confirmed selections", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const oldDigest = "1".repeat(64);
  const newDigest = "2".repeat(64);
  const observationBaseline = (
    locationId: string,
    snapshotId: string,
    revisionHeads: readonly {
      readonly id: string;
      readonly blobDigest: string;
    }[],
  ) =>
    createHash("sha256")
      .update(
        `{"artifactId":"artifact-confirmation","locationId":"${locationId}","modifiedAt":"2026-08-29T00:00:00.000Z","observedAt":"2026-08-29T00:00:00.000Z","revisionHeads":${JSON.stringify(revisionHeads)},"size":4,"snapshotId":"${snapshotId}"}`,
      )
      .digest("hex");
  const baselineA = observationBaseline(
    "location-confirmation-a",
    "snapshot-current",
    [{ blobDigest: oldDigest, id: "revision-old" }],
  );
  const baselineB = observationBaseline(
    "location-confirmation-b",
    "snapshot-current",
    [{ blobDigest: oldDigest, id: "revision-old" }],
  );
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  database.exec(`
    INSERT INTO observed_root_registrations (
      id, display_name, container_path, canonical_path, status, config_version,
      read_only, symlink_mode, allowed_target_root_ids_json
    ) VALUES ('confirmation-root', 'Confirmation root', '/observed', '/observed',
      'active', 1, 1, 'do-not-follow', '[]');
    INSERT INTO artifacts (id) VALUES ('artifact-confirmation');
    INSERT INTO blobs (digest, media_type, byte_length)
      VALUES ('${oldDigest}', 'application/octet-stream', 3);
    INSERT INTO artifact_revisions (id, artifact_id, blob_digest)
      VALUES ('revision-old', 'artifact-confirmation', '${oldDigest}');
    INSERT INTO locations (id, artifact_id, address, kind) VALUES
      ('location-confirmation-a', 'artifact-confirmation', '/observed/a.bin', 'observed'),
      ('location-confirmation-b', 'artifact-confirmation', '/observed/b.bin', 'observed');
    INSERT INTO current_file_observations (
      location_id, address, snapshot_id, observed_at, size, modified_at,
      conditional_baseline
    ) VALUES
      ('location-confirmation-a', '/observed/a.bin', 'snapshot-current', '2026-08-29T00:00:00.000Z',
       4, '2026-08-29T00:00:00.000Z', '${baselineA}'),
      ('location-confirmation-b', '/observed/b.bin', 'snapshot-current', '2026-08-29T00:00:00.000Z',
       4, '2026-08-29T00:00:00.000Z', '${baselineB}');
  `);
  database.close();
  const selectionA = await catalogue.observedFileSelectionForLocation(
    "location-confirmation-a",
  );
  const selectionB = await catalogue.observedFileSelectionForLocation(
    "location-confirmation-b",
  );
  if (selectionA === undefined || selectionB === undefined)
    throw new Error("missing current observed selection");
  const factsA = await catalogue.readObservedFileConfirmationFacts(selectionA);
  const factsB = await catalogue.readObservedFileConfirmationFacts(selectionB);
  if (factsA === undefined || factsB === undefined)
    throw new Error("missing current observed facts");
  const proof = {
    blobDigest: newDigest,
    scheme: "artifact-frame-manifest/1" as const,
    byteLength: 4,
    frameSize: 1_048_576 as const,
    frameCount: 1,
    manifestDigest: "4".repeat(64),
  };
  const revision = {
    id: "revision-current",
    artifactId: "artifact-confirmation",
    blobDigest: newDigest,
  };
  const confirmation = (expected: typeof factsA) => ({
    expected,
    observedAuthority: {
      registrationId: "confirmation-root",
      registrationVersion: 1,
    },
    blob: {
      digest: newDigest,
      mediaType: "application/octet-stream",
      byteLength: 4,
    },
    revision,
    proof,
  });

  await expect(
    catalogue.submitConfirmedObservedRevision(confirmation(factsA)),
  ).resolves.toBe("committed");
  await expect(
    catalogue.submitConfirmedObservedRevision(confirmation(factsA)),
  ).resolves.toBe("already-committed");
  await expect(
    catalogue.submitConfirmedObservedRevision({
      ...confirmation(factsA),
      blob: {
        digest: "7".repeat(64),
        mediaType: "application/octet-stream",
        byteLength: 4,
      },
      revision: {
        id: "revision-conflicting-old-selection",
        artifactId: "artifact-confirmation",
        blobDigest: "7".repeat(64),
      },
      proof: {
        ...proof,
        blobDigest: "7".repeat(64),
        manifestDigest: "8".repeat(64),
      },
    }),
  ).resolves.toBe("stale");
  await expect(
    catalogue.submitConfirmedObservedRevision(confirmation(factsB)),
  ).resolves.toBe("stale");
  const refreshedSnapshotId = "snapshot-refreshed";
  const refreshedBaselineB = observationBaseline(
    "location-confirmation-b",
    refreshedSnapshotId,
    [
      { blobDigest: newDigest, id: "revision-current" },
      { blobDigest: oldDigest, id: "revision-old" },
    ],
  );
  const refreshDatabase = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  refreshDatabase
    .prepare(
      `UPDATE current_file_observations
       SET snapshot_id = ?, conditional_baseline = ? WHERE location_id = ?`,
    )
    .run(refreshedSnapshotId, refreshedBaselineB, "location-confirmation-b");
  refreshDatabase.close();
  const refreshedSelectionB = await catalogue.observedFileSelectionForLocation(
    "location-confirmation-b",
  );
  if (refreshedSelectionB === undefined)
    throw new Error("missing refreshed observed selection");
  const refreshedFactsB =
    await catalogue.readObservedFileConfirmationFacts(refreshedSelectionB);
  if (refreshedFactsB === undefined)
    throw new Error("missing refreshed observed facts");
  await expect(
    catalogue.submitConfirmedObservedRevision(confirmation(refreshedFactsB)),
  ).resolves.toBe("committed");
  await expect(
    catalogue.observedFileSelectionForLocation("location-confirmation-a"),
  ).resolves.toBeUndefined();
  await expect(
    catalogue.readObservedFileConfirmationFacts(selectionA),
  ).resolves.toEqual(factsA);
  await expect(
    catalogue.submitConfirmedObservedRevision(
      confirmation({ ...factsA, conditionalBaseline: "5".repeat(64) }),
    ),
  ).resolves.toBe("stale");
  const verification = new DatabaseSync(path.join(root, "catalogue.sqlite"), {
    readOnly: true,
  });
  expect(
    verification
      .prepare(
        "SELECT location_id AS locationId FROM observed_revision_confirmations WHERE revision_id = ? ORDER BY location_id",
      )
      .all(revision.id),
  ).toEqual([
    { locationId: "location-confirmation-a" },
    { locationId: "location-confirmation-b" },
  ]);
  verification.close();
  catalogue.close();
});

it("removes a stale current observation when ordinary acceptance carries a complete snapshot that omits it", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  database.exec(`
    INSERT INTO artifacts (id) VALUES ('artifact');
    INSERT INTO locations (id, artifact_id, address, kind)
      VALUES ('location', 'artifact', '/observed/missing.bin', 'observed');
    INSERT INTO current_file_observations (
      location_id, address, snapshot_id, observed_at, size, modified_at,
      conditional_baseline
    ) VALUES (
      'location', '/observed/missing.bin', 'stale-snapshot', '2026-08-28T00:00:00.000Z', 4,
      '2026-08-28T00:00:00.000Z', '${"6".repeat(64)}'
    );
  `);
  database.close();
  await expect(
    catalogue.observedFileSelectionForLocation("location"),
  ).resolves.toMatch(/^observed-file-selection_1_/u);
  const currentAccepted = {
    ...accepted(),
    locations: [
      {
        id: "location",
        artifactId: "artifact",
        address: "/observed/missing.bin",
        kind: "observed" as const,
      },
    ],
  };
  await catalogue.createExecution(execution());
  await retainSourceRecords(catalogue, "execution", [sourceRecord()]);
  await acceptRecognition(catalogue, {
    execution: acceptedExecution(),
    accepted: currentAccepted,
  });

  await expect(
    catalogue.observedFileSelectionForLocation("location"),
  ).resolves.toBeUndefined();
  catalogue.close();
});

async function createCatalogueWithRoot(options?: SqliteCatalogueOptions) {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  return {
    root,
    catalogue: SqliteCatalogue.forProductData(root, options),
  };
}

async function createCatalogue(options?: SqliteCatalogueOptions) {
  return (await createCatalogueWithRoot(options)).catalogue;
}

it("公开身份旅程建立、选择并在重开后保留本地相关实体和种类决定", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const workflow = reevaluationWorkflow(catalogue, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  const person = await workflow.createLocalRelatedEntity({
    commitmentId: "person/1",
    label: "同名作者",
    kind: "person",
    actorId: "user:甲",
  });
  const series = await workflow.createLocalRelatedEntity({
    commitmentId: "series/1",
    label: "同名作者",
    kind: "entity",
    actorId: "user:甲",
  });
  const personOverride = await workflow.previewEntityKindDecision({
    entityId: person.id,
    selectedKind: "persona",
  });
  await expect(
    workflow.applyEntityKindDecision({
      entityId: person.id,
      selectedKind: "persona",
      actorId: "user:甲",
      baseline: personOverride.baseline,
    }),
  ).resolves.toBe("applied");
  await expect(
    workflow.createLocalRelatedEntity({
      commitmentId: "person/1",
      label: "同名作者",
      kind: "person",
      actorId: "user:甲",
    }),
  ).resolves.toMatchObject({ id: person.id, identity: "local" });
  await expect(
    workflow.createLocalRelatedEntity({
      commitmentId: "person/1",
      label: "不同名称",
      kind: "person",
      actorId: "user:甲",
    }),
  ).rejects.toThrow("本地身份提交坐标与既有内容冲突");
  const anotherPerson = await workflow.createLocalRelatedEntity({
    commitmentId: "person/2",
    label: "同名作者",
    kind: "person",
    actorId: "user:甲",
  });
  expect(anotherPerson.id).not.toBe(person.id);
  expect(person.id).not.toBe(series.id);
  await expect(workflow.findRelatedEntities("同名作者")).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: person.id,
        kind: { status: "effective", kind: "persona", basis: "decision" },
        identity: "local",
      }),
      expect.objectContaining({
        id: series.id,
        kind: { status: "ordinary" },
        identity: "local",
      }),
    ]),
  );
  const preview = await workflow.previewEntityKindDecision({
    entityId: series.id,
    selectedKind: "persona",
  });
  expect(preview.effective).toEqual({ status: "ordinary" });
  await expect(
    workflow.applyEntityKindDecision({
      entityId: series.id,
      selectedKind: "persona",
      actorId: "user:甲",
      baseline: preview.baseline,
    }),
  ).resolves.toBe("applied");
  const correction = await workflow.previewEntityKindDecision({
    entityId: series.id,
    selectedKind: "person",
  });
  await expect(
    workflow.applyEntityKindDecision({
      entityId: series.id,
      selectedKind: "persona",
      actorId: "user:甲",
      baseline: correction.baseline,
    }),
  ).resolves.toBe("applied");
  await expect(
    workflow.applyEntityKindDecision({
      entityId: series.id,
      selectedKind: "person",
      actorId: "user:甲",
      baseline: correction.baseline,
    }),
  ).resolves.toBe("stale");
  const clear = await workflow.previewEntityKindDecision({
    entityId: series.id,
  });
  await expect(
    workflow.applyEntityKindDecision({
      entityId: series.id,
      actorId: "user:甲",
      baseline: clear.baseline,
    }),
  ).resolves.toBe("applied");
  await expect(workflow.findRelatedEntities("同名作者")).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: series.id, kind: { status: "ordinary" } }),
    ]),
  );
  const repeat = await workflow.previewEntityKindDecision({
    entityId: series.id,
    selectedKind: "persona",
  });
  await expect(
    workflow.applyEntityKindDecision({
      entityId: series.id,
      selectedKind: "persona",
      actorId: "user:甲",
      baseline: repeat.baseline,
    }),
  ).resolves.toBe("applied");
  await expect(
    workflow.inspectCurrentCatalogueEntity(series.id),
  ).resolves.toMatchObject({
    entity: {
      id: series.id,
      label: "同名作者",
      kind: { status: "effective", kind: "persona", basis: "decision" },
    },
    relationships: [],
    accepted: [],
  });
  catalogue.close();
  const reopened = SqliteCatalogue.forProductData(root);
  const reopenedWorkflow = reevaluationWorkflow(reopened, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  await expect(
    reopenedWorkflow.createLocalRelatedEntity({
      commitmentId: "person/1",
      label: "同名作者",
      kind: "person",
      actorId: "user:甲",
    }),
  ).resolves.toMatchObject({ id: person.id });
  await expect(reopened.findRelatedEntities("同名作者")).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: series.id,
        kind: { status: "effective", kind: "persona", basis: "decision" },
      }),
    ]),
  );
  reopened.close();
});

it("公开关系旅程预演、更正多方关系内序位、重开后保留并可清除", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const workflow = reevaluationWorkflow(catalogue, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  await catalogue.createExecution(execution());
  await retainSourceRecords(catalogue, "execution", [sourceRecord()]);
  await acceptRecognition(catalogue, {
    execution: acceptedExecution(),
    accepted: accepted(),
  });
  const [series, performer] = await Promise.all([
    workflow.createLocalRelatedEntity({
      commitmentId: "series",
      label: "本地系列",
      kind: "entity",
      actorId: "user:甲",
    }),
    workflow.createLocalRelatedEntity({
      commitmentId: "performer",
      label: "表演者",
      kind: "person",
      actorId: "user:甲",
    }),
  ]);
  const fix = {
    kind: "fix" as const,
    definitionId: "fixture.membership-three",
    relationship: {
      type: "asset.membership",
      participants: [
        { entityId: series.id, role: "series" },
        { entityId: "asset", role: "member" },
        { entityId: performer.id, role: "performer" },
      ],
      qualifiers: [{ key: "asset.membership.position", value: "2" }],
    },
  };
  await expect(
    workflow.previewRelationshipChange({ changes: [fix] }),
  ).resolves.toMatchObject({
    relationships: expect.arrayContaining([
      expect.objectContaining({ type: "asset.membership" }),
    ]),
  });
  const preview = await workflow.previewRelationshipChange({ changes: [fix] });
  await expect(
    workflow.applyRelationshipChange({ actorId: "user:甲", preview }),
  ).resolves.toBe("applied");
  await expect(
    workflow.inspectCurrentCatalogueEntity(series.id),
  ).resolves.toMatchObject({
    relationships: [
      expect.objectContaining({
        type: "asset.membership",
        participants: expect.arrayContaining([
          { entityId: "asset", role: "member" },
          { entityId: performer.id, role: "performer" },
        ]),
        qualifiers: [{ key: "asset.membership.position", value: "2" }],
      }),
    ],
    accepted: [expect.any(Object)],
  });
  const repeated = await workflow.previewRelationshipChange({ changes: [fix] });
  await expect(
    workflow.applyRelationshipChange({ actorId: "user:甲", preview: repeated }),
  ).resolves.toBe("applied");
  await expect(
    workflow.inspectCurrentCatalogueEntity(series.id),
  ).resolves.toMatchObject({
    relationships: [expect.objectContaining({ type: "asset.membership" })],
  });
  await expect(
    workflow.previewRelationshipChange({
      changes: [
        {
          ...fix,
          relationship: {
            ...fix.relationship,
            participants: [
              ...fix.relationship.participants,
              { entityId: series.id, role: "series" },
            ],
          },
        },
      ],
    }),
  ).rejects.toThrow("更正关系结构无效");
  await expect(
    workflow.previewRelationshipChange({
      changes: [
        {
          ...fix,
          relationship: {
            ...fix.relationship,
            qualifiers: [{ key: "", value: "2" }],
          },
        },
      ],
    }),
  ).rejects.toThrow("更正关系结构无效");
  await expect(
    workflow.previewRelationshipChange({
      changes: [
        {
          ...fix,
          relationship: {
            ...fix.relationship,
            qualifiers: [{ key: "asset.membership.position", value: "" }],
          },
        },
      ],
    }),
  ).rejects.toThrow("更正关系结构无效");
  await expect(
    workflow.previewRelationshipChange({
      changes: [
        {
          kind: "fix",
          definitionId: "fixture.membership-three",
          relationship: {
            type: "asset.membership",
            participants: [
              { entityId: series.id, role: "series" },
              { entityId: "asset", role: "member" },
            ],
          },
        },
      ],
    }),
  ).rejects.toThrow("关系缺少必需角色");
  catalogue.close();
  const reopened = SqliteCatalogue.forProductData(root);
  const reopenedWorkflow = reevaluationWorkflow(reopened, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  const current = await reopenedWorkflow.inspectCurrentCatalogueEntity(
    series.id,
  );
  const clear = await reopenedWorkflow.previewRelationshipChange({
    changes: [
      { kind: "clear", relationshipIds: [current!.relationships[0]!.id] },
    ],
  });
  await expect(
    reopenedWorkflow.applyRelationshipChange({
      actorId: "user:甲",
      preview: clear,
    }),
  ).resolves.toBe("applied");
  await expect(
    reopenedWorkflow.inspectCurrentCatalogueEntity(series.id),
  ).resolves.toMatchObject({ relationships: [] });
  reopened.close();
});

it("公开身份合并汇集关系、让新人工关系写入代表并能撤销", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const workflow = reevaluationWorkflow(catalogue, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  await catalogue.createExecution(execution());
  await retainSourceRecords(catalogue, "execution", [sourceRecord()]);
  await acceptRecognition(catalogue, {
    execution: acceptedExecution(),
    accepted: accepted(),
  });
  const [a, b, third] = await Promise.all(
    [
      ["identity/a", "甲身份"],
      ["identity/b", "乙身份"],
      ["identity/third", "第三方"],
    ].map(
      async ([commitmentId, label]) =>
        await workflow.createLocalRelatedEntity({
          commitmentId,
          label,
          kind: "entity",
          actorId: "user:甲",
        }),
    ),
  );
  const oldRelationship = {
    kind: "fix" as const,
    definitionId: "fixture.identity-reference",
    relationship: {
      type: "identity.reference",
      participants: [
        { entityId: b.id, role: "subject" },
        { entityId: third.id, role: "context" },
      ],
    },
  };
  const oldPreview = await workflow.previewRelationshipChange({
    changes: [oldRelationship],
  });
  await expect(
    workflow.applyRelationshipChange({
      actorId: "user:甲",
      preview: oldPreview,
    }),
  ).resolves.toBe("applied");
  const staleAfterRelationshipDecision =
    await workflow.previewEntityIdentityMerge({
      retainedEntityId: a.id,
      mergedEntityId: b.id,
    });
  const excludeOldRelationship = await workflow.previewRelationshipChange({
    changes: [
      {
        kind: "exclude",
        relationshipIds: [
          oldPreview.relationships.find(
            ({ type }) => type === "identity.reference",
          )!.id,
        ],
      },
    ],
  });
  await workflow.applyRelationshipChange({
    actorId: "user:甲",
    preview: excludeOldRelationship,
  });
  await expect(
    workflow.applyEntityIdentityMerge({
      commitmentId: "identity/stale-relationship",
      actorId: "user:甲",
      preview: staleAfterRelationshipDecision,
    }),
  ).resolves.toBe("stale");
  const restoreOldRelationship = await workflow.previewRelationshipChange({
    changes: [
      {
        kind: "select",
        relationshipIds: [
          oldPreview.relationships.find(
            ({ type }) => type === "identity.reference",
          )!.id,
        ],
      },
    ],
  });
  await workflow.applyRelationshipChange({
    actorId: "user:甲",
    preview: restoreOldRelationship,
  });
  const merge = await workflow.previewEntityIdentityMerge({
    retainedEntityId: a.id,
    mergedEntityId: b.id,
  });
  const beforeMergeKind = await workflow.previewEntityKindDecision({
    entityId: b.id,
    selectedKind: "persona",
  });
  expect(merge.members).toEqual(expect.arrayContaining([a.id, b.id]));
  await expect(
    workflow.applyEntityIdentityMerge({
      commitmentId: "identity/merge-a-b",
      actorId: "user:甲",
      preview: merge,
    }),
  ).resolves.toBe("applied");
  await expect(
    workflow.applyEntityIdentityMerge({
      commitmentId: "identity/merge-a-b-other",
      actorId: "user:乙",
      preview: merge,
    }),
  ).resolves.toBe("stale");
  await expect(
    workflow.applyEntityKindDecision({
      entityId: b.id,
      selectedKind: "persona",
      actorId: "user:甲",
      baseline: beforeMergeKind.baseline,
    }),
  ).resolves.toBe("stale");
  await expect(
    workflow.applyEntityIdentityMerge({
      commitmentId: "identity/merge-a-b",
      actorId: "user:甲",
      preview: merge,
    }),
  ).resolves.toBe("applied");
  for (const entityId of [a.id, b.id, third.id])
    await expect(
      workflow.inspectCurrentCatalogueEntity(entityId),
    ).resolves.toMatchObject({
      relationships: [
        expect.objectContaining({
          type: "identity.reference",
          participants: expect.arrayContaining([
            { entityId: a.id, role: "subject" },
            { entityId: third.id, role: "context" },
          ]),
        }),
      ],
    });
  await expect(
    workflow.inspectCurrentCatalogueEntity(b.id),
  ).resolves.toMatchObject({
    entity: { id: a.id },
  });
  const newManualPreview = await workflow.previewRelationshipChange({
    changes: [
      {
        kind: "fix",
        definitionId: "fixture.membership",
        relationship: {
          type: "asset.membership",
          participants: [
            { entityId: b.id, role: "series" },
            { entityId: "asset", role: "member" },
          ],
          qualifiers: [{ key: "asset.membership.position", value: "2" }],
        },
      },
    ],
  });
  expect(newManualPreview.changes[0]!.relationship!.participants[0]).toEqual({
    entityId: a.id,
    role: "series",
  });
  await expect(
    workflow.applyRelationshipChange({
      actorId: "user:甲",
      preview: newManualPreview,
    }),
  ).resolves.toBe("applied");
  catalogue.close();
  const reopened = SqliteCatalogue.forProductData(root);
  const reopenedWorkflow = reevaluationWorkflow(reopened, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  const undo = await reopenedWorkflow.previewEntityIdentityMerge({
    retainedEntityId: a.id,
    mergedEntityId: b.id,
  });
  expect(undo.mergeId).toBeDefined();
  await expect(
    reopenedWorkflow.undoEntityIdentityMerge({
      commitmentId: "identity/undo-a-b",
      actorId: "user:甲",
      preview: undo,
    }),
  ).resolves.toBe("applied");
  const [otherRetained, otherMerged] = await Promise.all(
    ["identity/undo-other-a", "identity/undo-other-b"].map(
      async (commitmentId) =>
        await reopenedWorkflow.createLocalRelatedEntity({
          commitmentId,
          label: commitmentId,
          kind: "entity",
          actorId: "user:甲",
        }),
    ),
  );
  const otherMerge = await reopenedWorkflow.previewEntityIdentityMerge({
    retainedEntityId: otherRetained.id,
    mergedEntityId: otherMerged.id,
  });
  await reopenedWorkflow.applyEntityIdentityMerge({
    commitmentId: "identity/undo-other-merge",
    actorId: "user:甲",
    preview: otherMerge,
  });
  const otherUndo = await reopenedWorkflow.previewEntityIdentityMerge({
    retainedEntityId: otherRetained.id,
    mergedEntityId: otherMerged.id,
  });
  await expect(
    reopenedWorkflow.undoEntityIdentityMerge({
      commitmentId: "identity/undo-a-b",
      actorId: "user:甲",
      preview: otherUndo,
    }),
  ).rejects.toThrow("撤销提交坐标与既有内容冲突");
  await expect(
    reopenedWorkflow.undoEntityIdentityMerge({
      commitmentId: "identity/undo-a-b",
      actorId: "user:甲",
      preview: undo,
    }),
  ).resolves.toBe("applied");
  await expect(
    reopenedWorkflow.inspectCurrentCatalogueEntity(b.id),
  ).resolves.toMatchObject({
    entity: { id: b.id },
    relationships: [expect.objectContaining({ type: "identity.reference" })],
  });
  await expect(
    reopenedWorkflow.inspectCurrentCatalogueEntity(a.id),
  ).resolves.toMatchObject({
    entity: { id: a.id },
    relationships: [expect.objectContaining({ type: "asset.membership" })],
  });
  await expect(
    reopenedWorkflow.inspectCurrentCatalogueEntity(b.id),
  ).resolves.not.toMatchObject({
    relationships: expect.arrayContaining([
      expect.objectContaining({ type: "asset.membership" }),
    ]),
  });
  reopened.close();
});

it("公开身份合并拒绝数字资产、种类冲突和会折叠坏的既有关系", async () => {
  const { catalogue } = await createCatalogueWithRoot();
  const workflow = reevaluationWorkflow(catalogue, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  await catalogue.createExecution(execution());
  await retainSourceRecords(catalogue, "execution", [sourceRecord()]);
  await acceptRecognition(catalogue, {
    execution: acceptedExecution(),
    accepted: accepted(),
  });
  const [a, b, person, persona] = await Promise.all(
    [
      ["unsafe/a", "甲", "entity"],
      ["unsafe/b", "乙", "entity"],
      ["unsafe/person", "人物", "person"],
      ["unsafe/persona", "活动身份", "persona"],
    ].map(
      async ([commitmentId, label, kind]) =>
        await workflow.createLocalRelatedEntity({
          commitmentId,
          label,
          kind: kind as "entity" | "person" | "persona",
          actorId: "user:甲",
        }),
    ),
  );
  await expect(
    workflow.previewEntityIdentityMerge({
      retainedEntityId: a.id,
      mergedEntityId: "asset",
    }),
  ).rejects.toThrow("数字资产不能进行身份合并");
  await expect(
    workflow.previewEntityIdentityMerge({
      retainedEntityId: person.id,
      mergedEntityId: persona.id,
    }),
  ).rejects.toThrow("种类冲突");
  const relationship = await workflow.previewRelationshipChange({
    changes: [
      {
        kind: "fix",
        definitionId: "fixture.identity-ambiguous",
        relationship: {
          type: "identity.ambiguous",
          participants: [
            { entityId: a.id, role: "subject" },
            { entityId: b.id, role: "subject" },
          ],
        },
      },
    ],
  });
  await workflow.applyRelationshipChange({
    actorId: "user:甲",
    preview: relationship,
  });
  await expect(
    workflow.previewEntityIdentityMerge({
      retainedEntityId: a.id,
      mergedEntityId: b.id,
    }),
  ).rejects.toThrow("现有关系结构无效");
  catalogue.close();
});

it("身份合并只让相关关系更正过期，并拒绝恢复会折叠的人工关系", async () => {
  const { catalogue } = await createCatalogueWithRoot();
  const workflow = reevaluationWorkflow(catalogue, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  const [a, b, c, d] = await Promise.all(
    ["scoped/a", "scoped/b", "scoped/c", "scoped/d"].map(
      async (commitmentId) =>
        await workflow.createLocalRelatedEntity({
          commitmentId,
          label: commitmentId,
          kind: "entity",
          actorId: "user:甲",
        }),
    ),
  );
  const unrelatedMerge = await workflow.previewEntityIdentityMerge({
    retainedEntityId: a.id,
    mergedEntityId: b.id,
  });
  const unrelatedChange = await workflow.previewRelationshipChange({
    changes: [
      {
        kind: "fix",
        definitionId: "fixture.identity-context",
        relationship: {
          type: "identity.context",
          participants: [
            { entityId: c.id, role: "subject" },
            { entityId: d.id, role: "context" },
          ],
        },
      },
    ],
  });
  await workflow.applyRelationshipChange({
    actorId: "user:甲",
    preview: unrelatedChange,
  });
  await expect(
    workflow.applyEntityIdentityMerge({
      commitmentId: "scoped/merge",
      actorId: "user:甲",
      preview: unrelatedMerge,
    }),
  ).resolves.toBe("applied");

  const [left, right] = await Promise.all(
    ["restore/left", "restore/right"].map(
      async (commitmentId) =>
        await workflow.createLocalRelatedEntity({
          commitmentId,
          label: commitmentId,
          kind: "entity",
          actorId: "user:甲",
        }),
    ),
  );
  const unsafe = await workflow.previewRelationshipChange({
    changes: [
      {
        kind: "fix",
        definitionId: "fixture.identity-ambiguous",
        relationship: {
          type: "identity.ambiguous",
          participants: [
            { entityId: left.id, role: "subject" },
            { entityId: right.id, role: "subject" },
          ],
        },
      },
    ],
  });
  await workflow.applyRelationshipChange({
    actorId: "user:甲",
    preview: unsafe,
  });
  const unsafeId = unsafe.relationships.find(
    ({ type }) => type === "identity.ambiguous",
  )!.id;
  const exclude = await workflow.previewRelationshipChange({
    changes: [{ kind: "exclude", relationshipIds: [unsafeId] }],
  });
  await workflow.applyRelationshipChange({
    actorId: "user:甲",
    preview: exclude,
  });
  const merge = await workflow.previewEntityIdentityMerge({
    retainedEntityId: left.id,
    mergedEntityId: right.id,
  });
  await workflow.applyEntityIdentityMerge({
    commitmentId: "restore/merge",
    actorId: "user:甲",
    preview: merge,
  });
  await expect(
    workflow.previewRelationshipChange({
      changes: [{ kind: "select", relationshipIds: [unsafeId] }],
    }),
  ).rejects.toThrow("身份合并会使当前关系结构无效");
  catalogue.close();
});

it("孤立身份合并按当前资料投影汇集值与冲突，并在撤销后恢复原属", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const base = {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
    explicitPlan: false,
    sourceRefreshAuthority: true,
    omitPersona: true,
    omitSourceSubjectRelationship: true,
    sourceSubjectDisplayName: "共同资料名称",
    metadataPolicyConfiguration: {
      version: "isolated-identity-metadata/1",
      policies: [
        {
          id: "isolated-identity-alias",
          metadataUsageContext: "asset.ordinary",
          rules: [
            {
              property: "entity.alias",
              preferredSourceIdentities: [],
              cardinality: "one",
            },
          ],
        },
      ],
      select: () => ["isolated-identity-alias"],
    },
  };
  const alphaState = {
    ...base,
    sourceResolvedSubject: "alpha" as const,
    sourceSubjectAlias: "甲别名",
  };
  const alpha = reevaluationWorkflow(catalogue, alphaState);
  const beta = reevaluationWorkflow(catalogue, {
    ...base,
    sourceResolvedSubject: "beta" as const,
    sourceSubjectAlias: "乙别名",
    sourceAddress: "opaque:isolated-identity-beta",
    sourceRecordPrefix: "isolated-identity-beta-record",
  });
  const [alphaScan, betaScan] = await Promise.all([
    scanFixtureRegisteredObservedScope(alpha, {
      directory: "/observed/related-refresh",
      executionId: "isolated-identity-alpha",
      acceptTrusted: true,
    }),
    scanFixtureRegisteredObservedScope(beta, {
      directory: "/observed/related-lineage-b",
      executionId: "isolated-identity-beta",
      acceptTrusted: true,
    }),
  ]);
  await expect(
    catalogue.inspectExecution(alphaScan.execution.id),
  ).resolves.toMatchObject({ accepted: expect.any(Object) });
  await expect(
    catalogue.inspectExecution(betaScan.execution.id),
  ).resolves.toMatchObject({ accepted: expect.any(Object) });
  const alphaId = "reevaluation-source-subject-alpha";
  const betaId = "reevaluation-source-subject-beta";
  await expect(
    alpha.inspectCurrentCatalogueEntity(alphaId),
  ).resolves.toMatchObject({ relationships: [] });
  await expect(
    alpha.inspectCurrentCatalogueEntity(betaId),
  ).resolves.toMatchObject({ relationships: [] });
  const preview = await alpha.previewEntityIdentityMerge({
    retainedEntityId: alphaId,
    mergedEntityId: betaId,
  });
  expect(preview).toMatchObject({
    metadata: [
      expect.objectContaining({
        entityId: alphaId,
        property: "entity.display-name",
        value: "共同资料名称",
      }),
    ],
    metadataConflicts: [
      {
        subjectId: alphaId,
        property: "entity.alias",
        reason: "multiple-values",
        cardinality: "one",
        metadataUsageContext: "asset.ordinary",
      },
    ],
  });
  expect(JSON.stringify(preview.metadataConflicts)).not.toMatch(
    /candidates|sourceIdentity|sourceRecordIds|sourceSlot|assertion/,
  );
  const reorderedPreview = {
    ...preview,
    members: [...preview.members].reverse(),
    relationshipIds: [...preview.relationshipIds].reverse(),
    metadata: [...preview.metadata]
      .reverse()
      .map(({ entityId, property, value }) => ({ value, property, entityId })),
    metadataConflicts: [...preview.metadataConflicts]
      .reverse()
      .map(
        ({
          subjectId,
          property,
          reason,
          cardinality,
          metadataUsageContext,
        }) => ({
          metadataUsageContext,
          cardinality,
          reason,
          property,
          subjectId,
        }),
      ),
    effectiveKind:
      preview.effectiveKind.status === "ordinary"
        ? { status: "ordinary" as const }
        : preview.effectiveKind.status === "effective"
          ? {
              basis: preview.effectiveKind.basis,
              kind: preview.effectiveKind.kind,
              status: "effective" as const,
            }
          : {
              kinds: [...preview.effectiveKind.kinds].reverse(),
              status: "conflict" as const,
            },
  };
  const changedPolicyState = {
    ...alphaState,
    metadataPolicyConfiguration: {
      ...base.metadataPolicyConfiguration,
      version: "isolated-identity-metadata/2",
      policies: [
        {
          ...base.metadataPolicyConfiguration.policies[0]!,
          rules: [
            {
              property: "entity.alias",
              preferredSourceIdentities: [],
              cardinality: "many",
            },
          ],
        },
      ],
    },
  };
  const changedPolicy = reevaluationWorkflow(catalogue, changedPolicyState);
  await expect(
    changedPolicy.applyEntityIdentityMerge({
      commitmentId: "isolated-identity/merge",
      actorId: "user:甲",
      preview,
    }),
  ).resolves.toBe("stale");
  const changedPreview = await changedPolicy.previewEntityIdentityMerge({
    retainedEntityId: alphaId,
    mergedEntityId: betaId,
  });
  await expect(
    changedPolicy.applyEntityIdentityMerge({
      commitmentId: "isolated-identity/merge-spliced",
      actorId: "user:甲",
      preview: {
        ...preview,
        metadataPolicyBaseline: changedPreview.metadataPolicyBaseline,
      },
    }),
  ).resolves.toBe("stale");
  await expect(
    changedPolicy.inspectCurrentCatalogueEntity(betaId),
  ).resolves.toMatchObject({ entity: { id: betaId } });
  catalogue.close();
  const reopened = SqliteCatalogue.forProductData(root);
  const adopted = reevaluationWorkflow(reopened, alphaState);
  await expect(
    adopted.applyEntityIdentityMerge({
      commitmentId: "isolated-identity/merge",
      actorId: "user:甲",
      preview: reorderedPreview,
    }),
  ).resolves.toBe("applied");
  const replayedAfterPolicyChange = reevaluationWorkflow(reopened, {
    ...changedPolicyState,
  });
  await expect(
    replayedAfterPolicyChange.applyEntityIdentityMerge({
      commitmentId: "isolated-identity/merge",
      actorId: "user:甲",
      preview,
    }),
  ).resolves.toBe("applied");
  const changedImpactPreviews = [
    () => ({ ...preview, retainedEntityId: betaId }),
    () => ({ ...preview, mergedEntityId: alphaId }),
    () => ({ ...preview, members: [...preview.members, "tampered-member"] }),
    () => ({
      ...preview,
      relationshipIds: [...preview.relationshipIds, "tampered-relationship"],
    }),
    () => ({
      ...preview,
      metadata: [
        ...preview.metadata,
        {
          entityId: alphaId,
          property: "entity.tampered",
          value: "tampered",
        },
      ],
    }),
    () => ({
      ...preview,
      metadataConflicts: [
        ...preview.metadataConflicts,
        {
          subjectId: alphaId,
          property: "entity.tampered",
          reason: "multiple-values" as const,
          cardinality: "one" as const,
          metadataUsageContext: "asset.ordinary",
        },
      ],
    }),
    () => ({ ...preview, effectiveKind: { status: "ordinary" as const } }),
    () => ({ ...preview, metadataPolicyBaseline: "tampered-policy" }),
    () => ({ ...preview, baseline: "tampered-facts" }),
  ];
  for (const changedPreview of changedImpactPreviews)
    await expect(
      replayedAfterPolicyChange.applyEntityIdentityMerge({
        commitmentId: "isolated-identity/merge",
        actorId: "user:甲",
        preview: changedPreview(),
      }),
    ).rejects.toThrow("身份合并提交坐标与既有内容冲突");
  const [fromAlpha, fromBeta] = await Promise.all(
    [alphaId, betaId].map(async (entityId) => {
      const current = await adopted.inspectCurrentCatalogueEntity(entityId);
      expect(current).toMatchObject({
        entity: { id: alphaId },
        relationships: [],
        metadata: [
          expect.objectContaining({
            subjectId: alphaId,
            property: "entity.display-name",
            value: "共同资料名称",
          }),
        ],
        metadataConflicts: [
          expect.objectContaining({
            property: "entity.alias",
            subjectId: alphaId,
          }),
        ],
      });
      return current!;
    }),
  );
  expect(fromAlpha.metadata).toEqual(fromBeta.metadata);
  expect(fromAlpha.metadataConflicts).toEqual(fromBeta.metadataConflicts);
  expect(preview.metadata).toEqual(
    fromAlpha.metadata.map(({ subjectId, property, value }) => ({
      entityId: subjectId,
      property,
      value,
    })),
  );
  expect(preview.metadataConflicts).toEqual(fromAlpha.metadataConflicts);
  const undo = await adopted.previewEntityIdentityMerge({
    retainedEntityId: alphaId,
    mergedEntityId: betaId,
  });
  await expect(
    adopted.undoEntityIdentityMerge({
      commitmentId: "isolated-identity/undo",
      actorId: "user:甲",
      preview: undo,
    }),
  ).resolves.toBe("applied");
  for (const [entityId, alias] of [
    [alphaId, "甲别名"],
    [betaId, "乙别名"],
  ] as const)
    await expect(
      adopted.inspectCurrentCatalogueEntity(entityId),
    ).resolves.toMatchObject({
      entity: { id: entityId },
      relationships: [],
      metadata: expect.arrayContaining([
        expect.objectContaining({
          subjectId: entityId,
          property: "entity.alias",
          value: alias,
        }),
      ]),
      metadataConflicts: [],
    });
  reopened.close();
});

it("公开身份合并不改写来源刷新，并把随后人工关系留在代表", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const state = {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
    explicitPlan: false,
    sourceRefreshAuthority: true,
    relatedMention: true,
    personaKind: "persona" as const,
  };
  const workflow = reevaluationWorkflow(catalogue, state);
  const initial = await scanFixtureRegisteredObservedScope(workflow, {
    directory: "/observed/related-refresh",
    executionId: "identity-merge-refresh-initial",
    acceptTrusted: true,
  });
  const subject = (await catalogue.inspectExecution(initial.execution.id))!
    .accepted!.entity.id;
  const retained = await workflow.createLocalRelatedEntity({
    commitmentId: "identity-refresh/retained",
    label: "保留身份",
    kind: "entity",
    actorId: "user:甲",
  });
  const beforeMergeMention = await workflow.inspectEntityMentionResolution(
    "reevaluation-voice-mention",
  );
  const beforeMergeManual = await workflow.previewRelationshipChange({
    changes: [
      {
        kind: "fix",
        definitionId: "fixture.membership",
        relationship: {
          type: "asset.membership",
          participants: [
            { entityId: "reevaluation-persona", role: "performer" },
            { entityId: subject, role: "member" },
          ],
        },
      },
    ],
  });
  const staleAfterSourceRefresh = await workflow.previewEntityIdentityMerge({
    retainedEntityId: retained.id,
    mergedEntityId: "reevaluation-persona",
  });
  state.sourceVersion = 1;
  await workflow.refreshMetadata({
    selection: {
      version: "asset-refresh-selection/1",
      subjects: [
        { subjectId: subject, explanations: [{ path: ["身份合并"] }] },
      ],
      filesystemScopes: [],
    },
    initiatedBy: "user:甲",
  });
  await expect(
    workflow.applyEntityIdentityMerge({
      commitmentId: "identity-refresh/stale-source",
      actorId: "user:甲",
      preview: staleAfterSourceRefresh,
    }),
  ).resolves.toBe("stale");
  const merge = await workflow.previewEntityIdentityMerge({
    retainedEntityId: retained.id,
    mergedEntityId: "reevaluation-persona",
  });
  await workflow.applyEntityIdentityMerge({
    commitmentId: "identity-refresh/merge",
    actorId: "user:甲",
    preview: merge,
  });
  await expect(
    workflow.applyRelationshipChange({
      actorId: "user:甲",
      preview: beforeMergeManual,
    }),
  ).resolves.toBe("stale");
  await expect(
    workflow.resolveEntityMentionManually({
      mentionId: beforeMergeMention.mentionId,
      entityId: "reevaluation-persona",
      actorId: "user:甲",
      baseline: beforeMergeMention.baseline,
    }),
  ).resolves.toBe("stale");
  await expect(
    workflow.inspectEntityMentionResolution("reevaluation-voice-mention"),
  ).resolves.toMatchObject({
    basis: "source",
    entityId: retained.id,
    sourceRecordIds: ["reevaluation-record-2"],
  });
  const manual = await workflow.previewRelationshipChange({
    changes: [
      {
        kind: "fix",
        definitionId: "fixture.membership",
        relationship: {
          type: "asset.membership",
          participants: [
            { entityId: "reevaluation-persona", role: "performer" },
            { entityId: subject, role: "member" },
          ],
        },
      },
    ],
  });
  expect(manual.changes[0]!.relationship!.participants[0]!.entityId).toBe(
    retained.id,
  );
  await workflow.applyRelationshipChange({
    actorId: "user:甲",
    preview: manual,
  });
  catalogue.close();
  const reopened = SqliteCatalogue.forProductData(root);
  const reopenedWorkflow = reevaluationWorkflow(reopened, state);
  const undo = await reopenedWorkflow.previewEntityIdentityMerge({
    retainedEntityId: retained.id,
    mergedEntityId: "reevaluation-persona",
  });
  await reopenedWorkflow.undoEntityIdentityMerge({
    commitmentId: "identity-refresh/undo",
    actorId: "user:甲",
    preview: undo,
  });
  await expect(
    reopenedWorkflow.inspectEntityMentionResolution(
      "reevaluation-voice-mention",
    ),
  ).resolves.toMatchObject({
    basis: "source",
    entityId: "reevaluation-persona",
    sourceRecordIds: ["reevaluation-record-2"],
  });
  await expect(
    reopenedWorkflow.inspectCurrentCatalogueEntity(retained.id),
  ).resolves.toMatchObject({
    relationships: [expect.objectContaining({ type: "asset.membership" })],
  });
  reopened.close();
});

it("公开交叉旅程保留自动关系、人工更正与指定身份合并的原属", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const state = {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
    explicitPlan: false,
    sourceRefreshAuthority: true,
    relatedMention: true,
    personaKind: "persona" as const,
  };
  const workflow = reevaluationWorkflow(catalogue, state);
  const initial = await scanFixtureRegisteredObservedScope(workflow, {
    directory: "/observed/related-refresh",
    executionId: "relationship-integration-initial",
    acceptTrusted: true,
  });
  const assetId = (await catalogue.inspectExecution(initial.execution.id))!
    .accepted!.entity.id;
  const retained = await workflow.createLocalRelatedEntity({
    commitmentId: "relationship-integration/retained",
    label: "保留身份",
    kind: "entity",
    actorId: "user:甲",
  });

  // 自动来源关系和手工更正均先按 B 的原身份成立。
  await expect(
    workflow.inspectCurrentCatalogueEntity("reevaluation-persona"),
  ).resolves.toMatchObject({
    entity: { id: "reevaluation-persona" },
    relationships: [expect.objectContaining({ type: "asset.contribution" })],
  });
  const correction = await workflow.previewRelationshipChange({
    changes: [
      {
        kind: "fix",
        definitionId: "fixture.identity-reference",
        relationship: {
          type: "identity.reference",
          participants: [
            { entityId: "reevaluation-persona", role: "subject" },
            { entityId: assetId, role: "context" },
          ],
        },
      },
    ],
  });
  await expect(
    workflow.applyRelationshipChange({
      actorId: "user:甲",
      preview: correction,
    }),
  ).resolves.toBe("applied");

  const merge = await workflow.previewEntityIdentityMerge({
    retainedEntityId: retained.id,
    mergedEntityId: "reevaluation-persona",
  });
  await expect(
    workflow.applyEntityIdentityMerge({
      commitmentId: "relationship-integration/merge-b-into-a",
      actorId: "user:甲",
      preview: merge,
    }),
  ).resolves.toBe("applied");

  // 刷新继续写入 B 的来源谱系；合并后的新人工关系则以 A 为目标。
  await workflow.refreshMetadata({
    selection: {
      version: "asset-refresh-selection/1",
      subjects: [
        { subjectId: assetId, explanations: [{ path: ["关系终端集成"] }] },
      ],
      filesystemScopes: [],
    },
    initiatedBy: "user:甲",
  });
  const postMergeManual = await workflow.previewRelationshipChange({
    changes: [
      {
        kind: "fix",
        definitionId: "fixture.membership",
        relationship: {
          type: "asset.membership",
          participants: [
            { entityId: "reevaluation-persona", role: "series" },
            { entityId: assetId, role: "member" },
          ],
        },
      },
    ],
  });
  expect(postMergeManual.changes[0]!.relationship!.participants[0]).toEqual({
    entityId: retained.id,
    role: "series",
  });
  await expect(
    workflow.applyRelationshipChange({
      actorId: "user:甲",
      preview: postMergeManual,
    }),
  ).resolves.toBe("applied");
  await expect(
    workflow.inspectCurrentCatalogueEntity("reevaluation-persona"),
  ).resolves.toMatchObject({
    entity: { id: retained.id },
    relationships: expect.arrayContaining([
      expect.objectContaining({ type: "asset.contribution" }),
      expect.objectContaining({ type: "identity.reference" }),
      expect.objectContaining({ type: "asset.membership" }),
    ]),
  });

  catalogue.close();
  const reopened = SqliteCatalogue.forProductData(root);
  const reopenedWorkflow = reevaluationWorkflow(reopened, state);
  const undo = await reopenedWorkflow.previewEntityIdentityMerge({
    retainedEntityId: retained.id,
    mergedEntityId: "reevaluation-persona",
  });
  await expect(
    reopenedWorkflow.undoEntityIdentityMerge({
      commitmentId: "relationship-integration/undo-b-into-a",
      actorId: "user:甲",
      preview: undo,
    }),
  ).resolves.toBe("applied");
  await expect(
    reopenedWorkflow.inspectEntityMentionResolution(
      "reevaluation-voice-mention",
    ),
  ).resolves.toMatchObject({
    basis: "source",
    entityId: "reevaluation-persona",
    sourceRecordIds: ["reevaluation-record-2"],
  });
  await expect(
    reopenedWorkflow.inspectCurrentCatalogueEntity("reevaluation-persona"),
  ).resolves.toMatchObject({
    entity: { id: "reevaluation-persona" },
    relationships: expect.arrayContaining([
      expect.objectContaining({ type: "asset.contribution" }),
      expect.objectContaining({ type: "identity.reference" }),
    ]),
  });
  await expect(
    reopenedWorkflow.inspectCurrentCatalogueEntity(retained.id),
  ).resolves.toMatchObject({
    entity: { id: retained.id },
    relationships: [expect.objectContaining({ type: "asset.membership" })],
  });
  await expect(
    reopenedWorkflow.inspectCurrentCatalogueEntity("reevaluation-persona"),
  ).resolves.not.toMatchObject({
    relationships: expect.arrayContaining([
      expect.objectContaining({ type: "asset.membership" }),
    ]),
  });
  reopened.close();
});

it("公开身份合并按根连接链，并让过期预演与同根环失败", async () => {
  const { catalogue } = await createCatalogueWithRoot();
  const workflow = reevaluationWorkflow(catalogue, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  const [a, b, c, staleLeft, staleRight] = await Promise.all(
    [
      "chain/a",
      "chain/b",
      "chain/c",
      "chain/stale-left",
      "chain/stale-right",
    ].map(
      async (commitmentId) =>
        await workflow.createLocalRelatedEntity({
          commitmentId,
          label: commitmentId,
          kind: "entity",
          actorId: "user:甲",
        }),
    ),
  );
  const stale = await workflow.previewEntityIdentityMerge({
    retainedEntityId: staleLeft.id,
    mergedEntityId: staleRight.id,
  });
  const first = await workflow.previewEntityIdentityMerge({
    retainedEntityId: a.id,
    mergedEntityId: b.id,
  });
  await workflow.applyEntityIdentityMerge({
    commitmentId: "chain/first",
    actorId: "user:甲",
    preview: first,
  });
  await expect(
    workflow.applyEntityIdentityMerge({
      commitmentId: "chain/stale",
      actorId: "user:甲",
      preview: stale,
    }),
  ).resolves.toBe("stale");
  const second = await workflow.previewEntityIdentityMerge({
    retainedEntityId: b.id,
    mergedEntityId: c.id,
  });
  expect(second).toMatchObject({
    retainedEntityId: a.id,
    mergedEntityId: c.id,
  });
  await workflow.applyEntityIdentityMerge({
    commitmentId: "chain/second",
    actorId: "user:甲",
    preview: second,
  });
  await expect(
    workflow.inspectCurrentCatalogueEntity(c.id),
  ).resolves.toMatchObject({
    entity: { id: a.id },
  });
  await expect(
    workflow.previewEntityIdentityMerge({
      retainedEntityId: c.id,
      mergedEntityId: a.id,
    }),
  ).rejects.toThrow("两个不同当前根");
  catalogue.close();
});

it("公开从普通实体返回自身、具名邻接关系和已收录内容，也区分孤立实体", async () => {
  const { catalogue } = await createCatalogueWithRoot();
  const workflow = reevaluationWorkflow(catalogue, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  const isolated = {
    id: "isolated-persona",
    kind: "persona" as const,
    sourceIdentity: "dlsite",
    sourceKey: "isolated",
    identityNamespace: "dlsite.credit.isolated",
    label: "Isolated credited name",
    sourceRecordIds: ["record"],
  };
  const dlsiteRecords = [
    {
      ...sourceRecord(),
      sourceIdentity: "dlsite",
      nativeAddress:
        "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
      coverage: {
        id: "dlsite.product-json",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      body: JSON.stringify({
        RJ01668691: {
          work_name: "First",
          regist_date: "2026-07-17",
          maker_id: "RG123",
          maker_name: "Circle",
        },
      }),
    },
    {
      ...sourceRecord(),
      id: "record-html",
      sourceIdentity: "dlsite",
      nativeAddress:
        "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
      coverage: {
        id: "dlsite.product-html",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      body: "<html />",
    },
  ];
  const dlsite = new DlsiteSourceInterpreter().interpret({
    evidence: [
      {
        kind: "directed-source-address",
        explanation: "test",
        sourceIdentity: "dlsite",
        sourceAddress: dlsiteRecords[0].nativeAddress,
        producer: {
          capabilityId: "dlsite.exact-directory",
          capabilityVersion: "1",
          contractVersion: "1",
        },
      },
    ],
    sourceRecords: dlsiteRecords,
  })[0]!;
  const circle = dlsite.entities!.find(
    (entity) => entity.sourceKey === "RG123",
  )!;
  const circleRelationship = dlsite.relationships!.find(
    (relationship) => relationship.participants[0]?.role === "circle",
  )!;
  const circleMention = dlsite.entityMentions!.find(
    (mention) => mention.sourceKey === "RG123",
  )!;
  const base = accepted();
  const acceptedWithIsolated = {
    ...base,
    sourceAssociations: [
      {
        ...base.sourceAssociations[0]!,
        sourceIdentity: "dlsite",
        nativeAddress: dlsiteRecords[0].nativeAddress,
      },
    ],
    recognitionSourceAssociation: {
      ...base.recognitionSourceAssociation,
      sourceIdentity: "dlsite",
      nativeAddress: dlsiteRecords[0].nativeAddress,
    },
    proposal: {
      ...base.proposal,
      basis: {
        ...base.proposal.basis,
        interpretation: {
          ...base.proposal.basis.interpretation,
          sourceIdentity: "dlsite",
          sourceAddress: dlsiteRecords[0].nativeAddress,
          sourceRecordIds: dlsiteRecords.map(({ id }) => id),
          entities: [circle, isolated],
          entityMentions: [circleMention],
          entityResolutionDecisions: dlsite.entityResolutionDecisions!.filter(
            (decision) => decision.mentionId === circleMention.id,
          ),
        },
      },
    },
    entities: [circle, isolated],
    entityMentions: [circleMention],
    entityResolutionDecisions: dlsite.entityResolutionDecisions!.filter(
      (decision) => decision.mentionId === circleMention.id,
    ),
    relationships: [
      {
        ...base.relationships![0]!,
        ...circleRelationship,
        id: "dlsite-circle-asset",
        participants: [
          { entityId: "asset", role: "asset" },
          ...circleRelationship.participants.map(
            ({ entityId, role, mentionIds }) => ({
              entityId,
              role,
              ...(mentionIds === undefined ? {} : { mentionIds }),
            }),
          ),
        ],
      },
    ],
  };
  await catalogue.createExecution(execution());
  await retainSourceRecords(catalogue, "execution", dlsiteRecords);
  await acceptRecognition(catalogue, {
    execution: acceptedExecution(),
    accepted: acceptedWithIsolated,
  });
  const localCircle = await workflow.createLocalRelatedEntity({
    commitmentId: "circle/1",
    label: "本地社团",
    kind: "entity",
    actorId: "user:甲",
  });
  const automatic = await workflow.inspectEntityMentionResolution(
    circleMention.id,
  );
  expect(automatic).toMatchObject({ basis: "source", entityId: circle.id });
  await expect(
    workflow.resolveEntityMentionManually({
      mentionId: circleMention.id,
      entityId: localCircle.id,
      actorId: "user:甲",
      baseline: automatic.baseline,
    }),
  ).resolves.toBe("applied");
  await expect(
    workflow.resolveEntityMentionManually({
      mentionId: circleMention.id,
      entityId: localCircle.id,
      actorId: "user:甲",
      baseline: automatic.baseline,
    }),
  ).resolves.toBe("stale");
  await expect(
    workflow.inspectEntityMentionResolution(circleMention.id),
  ).resolves.toMatchObject({
    basis: "manual",
    entityId: localCircle.id,
    actorId: "user:甲",
  });
  await expect(
    workflow.inspectCurrentCatalogueEntity(localCircle.id),
  ).resolves.toMatchObject({
    relationships: expect.arrayContaining([
      expect.objectContaining({
        participants: expect.arrayContaining([
          { entityId: localCircle.id, role: "circle" },
        ]),
      }),
    ]),
  });
  const manual = await workflow.inspectEntityMentionResolution(
    circleMention.id,
  );
  await expect(
    workflow.retractEntityMentionResolution({
      mentionId: circleMention.id,
      actorId: "user:甲",
      baseline: manual.baseline,
    }),
  ).resolves.toBe("applied");
  await expect(
    workflow.inspectEntityMentionResolution(circleMention.id),
  ).resolves.toMatchObject({
    basis: "source",
    entityId: circle.id,
  });
  const second = acceptedFor("asset-2", "record-asset-2");
  const secondRecord = {
    ...sourceRecordFor("asset-2"),
    sourceIdentity: "dlsite",
    nativeAddress: dlsiteRecords[0].nativeAddress,
    coverage: dlsiteRecords[0].coverage,
  };
  const secondCircle = { ...circle, sourceRecordIds: [secondRecord.id] };
  const secondAccepted = {
    ...second,
    sourceAssociations: [
      {
        ...second.sourceAssociations[0]!,
        sourceIdentity: "dlsite",
        nativeAddress: secondRecord.nativeAddress,
      },
    ],
    recognitionSourceAssociation: {
      ...second.recognitionSourceAssociation,
      sourceIdentity: "dlsite",
      nativeAddress: secondRecord.nativeAddress,
    },
    proposal: {
      ...second.proposal,
      basis: {
        ...second.proposal.basis,
        interpretation: {
          ...second.proposal.basis.interpretation,
          sourceIdentity: "dlsite",
          sourceAddress: secondRecord.nativeAddress,
          sourceRecordIds: [secondRecord.id],
          entities: [secondCircle],
          entityMentions: [],
          entityResolutionDecisions: [],
        },
      },
    },
    entities: [secondCircle],
    entityMentions: [],
    entityResolutionDecisions: [],
    relationships: [
      {
        ...second.relationships![0]!,
        ...circleRelationship,
        id: "dlsite-circle-asset-2",
        participants: [
          { entityId: "asset-2", role: "asset" },
          { entityId: circle.id, role: "circle" },
        ],
        sourceRecordIds: [secondRecord.id],
      },
    ],
  };
  await catalogue.createExecution(executionFor("execution-asset-2"));
  await retainSourceRecords(catalogue, "execution-asset-2", [secondRecord]);
  await acceptRecognition(catalogue, {
    execution: acceptedExecutionFor("execution-asset-2", "asset-2"),
    accepted: secondAccepted,
  });

  const circleInspection = await workflow.inspectCurrentCatalogueEntity(
    circle.id,
  );
  expect(circleInspection).toMatchObject({
    entity: { id: circle.id, label: "Circle" },
    relationships: expect.arrayContaining([
      expect.objectContaining({
        participants: expect.arrayContaining([
          { entityId: "asset", role: "asset" },
          { entityId: circle.id, role: "circle" },
        ]),
      }),
    ]),
  });
  expect(circleInspection?.accepted.map(({ entity }) => entity.id)).toEqual(
    expect.arrayContaining(["asset", "asset-2"]),
  );
  const workInspection = await workflow.inspectCurrentCatalogueSubject("asset");
  const secondWorkInspection =
    await workflow.inspectCurrentCatalogueSubject("asset-2");
  expect(workInspection?.relationships.map(({ id }) => id)).toContain(
    "dlsite-circle-asset",
  );
  expect(secondWorkInspection?.relationships.map(({ id }) => id)).toContain(
    "dlsite-circle-asset-2",
  );
  expect(circleInspection?.relationships.map(({ id }) => id)).toEqual(
    expect.arrayContaining(["dlsite-circle-asset", "dlsite-circle-asset-2"]),
  );
  expect(circleInspection?.relationships[0]).toMatchObject({
    sources: [
      {
        sourceIdentity: "dlsite",
        nativeAddress:
          "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
      },
    ],
  });
  expect(
    JSON.stringify({
      entity: circleInspection?.entity,
      relationships: circleInspection?.relationships,
    }),
  ).not.toMatch(/sourceRecordIds|sourceSlot|producer/);
  await expect(
    workflow.inspectCurrentCatalogueEntity("isolated-persona"),
  ).resolves.toMatchObject({
    entity: { id: "isolated-persona", label: "Isolated credited name" },
    relationships: [],
    accepted: [],
  });
  await expect(
    workflow.inspectCurrentCatalogueEntity("unknown-entity"),
  ).resolves.toBeUndefined();
  catalogue.close();
});

it("persists one local person's exact-revision playback state across restart", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const workflow = reevaluationWorkflow(catalogue, {
    observationVersion: 0,
    sourceVersion: 0,
    expanded: false,
    managedMissing: false,
    omitCover: false,
  });
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  database.exec(`
    INSERT INTO artifacts (id) VALUES ('interaction-artifact');
    INSERT INTO blobs (digest, media_type, byte_length)
      VALUES ('${"d".repeat(64)}', 'audio/mpeg', 1);
    INSERT INTO artifact_revisions (id, artifact_id, blob_digest)
      VALUES ('revision-old', 'interaction-artifact', '${"d".repeat(64)}'),
             ('revision-new', 'interaction-artifact', '${"d".repeat(64)}');
    INSERT INTO entity_kind_assertions (id, entity_id, kind, basis, source_record_ids_json)
      VALUES ('test-persona-conflict', 'person:local-user', 'persona', 'legacy-migration', '[]');
  `);
  database.close();

  await expect(
    catalogue.savePlaybackInteraction({
      artifactRevisionId: "revision-old",
      positionMilliseconds: 7_000,
      completed: true,
    }),
  ).rejects.toThrow("本地用户身份未准备");
  const person = await workflow.previewEntityKindDecision({
    entityId: "person:local-user",
    selectedKind: "person",
  });
  await expect(
    workflow.applyEntityKindDecision({
      entityId: "person:local-user",
      selectedKind: "person",
      actorId: "user:甲",
      baseline: person.baseline,
    }),
  ).resolves.toBe("applied");
  await catalogue.savePlaybackInteraction({
    artifactRevisionId: "revision-old",
    positionMilliseconds: 7_000,
    completed: true,
  });
  const clear = await workflow.previewEntityKindDecision({
    entityId: "person:local-user",
  });
  await expect(
    workflow.applyEntityKindDecision({
      entityId: "person:local-user",
      actorId: "user:甲",
      baseline: clear.baseline,
    }),
  ).resolves.toBe("applied");
  await expect(
    catalogue.savePlaybackInteraction({
      artifactRevisionId: "revision-old",
      positionMilliseconds: 7_000,
      completed: true,
    }),
  ).rejects.toThrow("本地用户身份未准备");
  const restore = await workflow.previewEntityKindDecision({
    entityId: "person:local-user",
    selectedKind: "person",
  });
  await expect(
    workflow.applyEntityKindDecision({
      entityId: "person:local-user",
      selectedKind: "person",
      actorId: "user:甲",
      baseline: restore.baseline,
    }),
  ).resolves.toBe("applied");

  await catalogue.savePlaybackInteraction({
    artifactRevisionId: "revision-old",
    positionMilliseconds: 7_000,
    completed: true,
  });
  catalogue.close();

  const restarted = SqliteCatalogue.forProductData(root);
  await expect(
    restarted.readPlaybackInteractions(["revision-new"]),
  ).resolves.toEqual([]);
  await expect(
    restarted.readPlaybackInteractions(["revision-old"]),
  ).resolves.toEqual([
    {
      artifactRevisionId: "revision-old",
      positionMilliseconds: 7_000,
      completed: true,
    },
  ]);
  restarted.close();
});

function fixtureObservedRootRegistration(
  id: string,
  logicalDirectory = path.resolve("/", id),
  configVersion = 1,
): ObservedRootRegistration {
  return {
    id,
    displayName: id,
    containerPath: logicalDirectory,
    canonicalPath: logicalDirectory,
    status: "active",
    configVersion,
    readOnly: true,
    symlinkMode: "do-not-follow",
    allowedTargetRootIds: [],
  };
}

/**
 * 每个内存工作流夹具都从显式注册开始。该列表刻意作为数据而非路径后备：
 * 新引入的测试目录必须先在此注册（或使用生产注册服务），之后才能绑定。
 */
const fixtureObservedDirectories = [
  "/another-bounded-scope",
  "/bounded",
  "/bounded-recovery",
  "/composed-checkpoints",
  "/incompatible-recovery",
  "/invalid-input-recovery",
  "/observed",
  "/observed/changed-configuration",
  "/observed/compatible-configuration",
  "/observed/conflicting-recovery",
  "/observed/cross-basis",
  "/observed/frozen-automation-configuration",
  "/observed/legacy-boundary",
  "/observed/missing-managed",
  "/observed/multi",
  "/observed/reevaluation",
  "/observed/related-refresh",
  "/observed/related-lineage-a",
  "/observed/related-lineage-b",
  "/observed/retraction-provenance",
  "/observed/source-refresh-acquiring",
  "/observed/source-refresh-authority",
  "/observed/source-refresh-cancel-in-flight",
  "/observed/source-refresh-cancellation",
  "/observed/source-refresh-concurrent-recovery",
  "/observed/source-refresh-normalized-facts",
  "/observed/source-refresh-partial-coverage",
  "/observed/source-refresh-public-retry",
  "/observed/source-refresh-rejection",
  "/observed/source-refresh-review",
  "/observed/source-refresh-sourced-subject",
  "/observed/source-refresh-sourced-subject-retraction",
  "/observed/source-refresh-stale-review",
  "/observed/source-refresh-startup-reprojection",
  "/observed/source-refresh-subject-coordinate",
  "/observed/unavailable-configuration",
  "/recovery-owner-handoff",
  "/retained-first",
  "/retained-sibling",
  "/shutdown-first",
  "/shutdown-sibling",
  "durable-left",
  "durable-right",
  "generation-one",
  "generation-two",
] as const;

function inMemoryObservedRootRegistrations(
  filesystemOptions?: InMemoryObservedFilesystemOptions,
): Pick<
  ObservedRootRegistrations,
  | "resolveActiveScope"
  | "rebindFrozenScope"
  | "assertFrozenRootsCurrent"
  | "capability"
  | "objectIdentityContract"
  | "observeBoundScope"
  | "openBoundByteSource"
  | "closeBoundScope"
  | "reportCleanupFailure"
> {
  const registrations =
    new InMemoryObservedRootRegistrationStore<ObservedRootRegistration>(
      fixtureObservedDirectories.map((directory) =>
        fixtureObservedRootRegistration(
          directory,
          path.resolve("/", directory),
        ),
      ),
    );
  const cleanupReporter = new InMemoryObservedRootCleanupReporter();
  return new ObservedRootRegistrations({
    commands: registrations.commands,
    queries: registrations.queries,
    filesystem: new InMemoryObservedFilesystemCapability(filesystemOptions),
    productDataDirectory: "/product-data",
    managedArtifactDirectory: "/product-data/managed-artifacts",
    cleanupFailureReporter: cleanupReporter,
    cleanupFailureFallback: cleanupReporter,
  });
}

/**
 * 测试迁移桥接。它把夹具中已注册的逻辑目录映射为注册身份，再调用生产公开扫描边界。
 * `AssetRefreshWorkflow` 不存在原始目录 API。
 */
async function scanFixtureRegisteredObservedScope(
  workflow: Pick<AssetRefreshWorkflow, "scanObservedScope">,
  input: Omit<
    Parameters<AssetRefreshWorkflow["scanObservedScope"]>[0],
    "registrationId" | "relativeScope"
  > & { readonly directory: string },
) {
  const { directory, ...request } = input;
  return await workflow.scanObservedScope({
    registrationId: directory,
    relativeScope: ".",
    ...request,
  });
}

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await disposePreparedCatalogueTemplate();
});

async function retainSourceRecords(
  catalogue: Pick<SqliteCatalogue, "inspectExecution" | "retainSourceRecords">,
  executionId: string,
  sourceRecords: readonly SourceRecord[],
): Promise<void> {
  const inspection = await catalogue.inspectExecution(executionId);
  if (inspection === undefined)
    throw new Error(`Unknown Workflow Execution ${executionId}`);
  const expectedExecution = inspection.execution;
  await catalogue.retainSourceRecords({
    expectedExecution,
    execution: {
      ...expectedExecution,
      sourceRecordIds: [
        ...new Set([
          ...expectedExecution.sourceRecordIds,
          ...sourceRecords.map((record) => record.id),
        ]),
      ],
    },
    sourceRecords,
  });
}

async function executionBaseline(
  catalogue: Pick<SqliteCatalogue, "inspectExecution">,
  executionId: string,
): Promise<WorkflowExecution> {
  const inspection = await catalogue.inspectExecution(executionId);
  if (inspection === undefined)
    throw new Error(`Unknown Workflow Execution ${executionId}`);
  return inspection.execution;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function rewriteChangeImpactPreviewsSchema(
  database: DatabaseSync,
  rewrite: (createTableSql: string) => string,
): void {
  const table = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'change_impact_previews'",
    )
    .get() as { readonly sql: string };
  const indexes = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'change_impact_previews' AND sql IS NOT NULL ORDER BY name",
    )
    .all() as readonly { readonly sql: string }[];
  const rewritten = rewrite(table.sql);
  expect(rewritten).not.toBe(table.sql);
  database.exec("DROP TABLE change_impact_previews");
  database.exec(rewritten);
  for (const index of indexes) database.exec(index.sql);
}

describe("SqliteCatalogue lifecycle", () => {
  it("persists an observed root registration across restart without creating automation", async () => {
    const { root: productDataDirectory, catalogue } =
      await createCatalogueWithRoot();
    const observedDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-observed-root-"),
    );
    cleanup.push(observedDirectory);
    const initialCleanupAudit = collectObservedRootCleanupFailure();
    const registrations = new ObservedRootRegistrations({
      commands: catalogue,
      queries: catalogue,
      filesystem: new ReadOnlyFilesystemObserver(),
      productDataDirectory,
      managedArtifactDirectory: path.join(
        productDataDirectory,
        "managed-artifacts",
      ),
      cleanupFailureReporter: initialCleanupAudit.reporter,
      cleanupFailureFallback: initialCleanupAudit.reporter,
    });

    const created = await registrations.create({
      displayName: "我的媒体",
      containerPath: observedDirectory,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    catalogue.close();

    const reopened = SqliteCatalogue.forProductData(productDataDirectory);
    const reopenedCleanupAudit = collectObservedRootCleanupFailure();
    const afterRestart = new ObservedRootRegistrations({
      commands: reopened,
      queries: reopened,
      filesystem: new ReadOnlyFilesystemObserver(),
      productDataDirectory,
      managedArtifactDirectory: path.join(
        productDataDirectory,
        "managed-artifacts",
      ),
      cleanupFailureReporter: reopenedCleanupAudit.reporter,
      cleanupFailureFallback: reopenedCleanupAudit.reporter,
    });
    await expect(afterRestart.get(created.id)).resolves.toEqual(created);
    await expect(afterRestart.list()).resolves.toEqual([created]);
    await expect(reopened.listAutomationIntents()).resolves.toEqual([]);
    reopened.close();
  });

  it("versions, revokes, and reconnects one root while allowing distinct parent and child registrations", async () => {
    const { root: productDataDirectory, catalogue } =
      await createCatalogueWithRoot();
    const observedDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-observed-parent-"),
    );
    cleanup.push(observedDirectory);
    const childDirectory = path.join(observedDirectory, "child");
    await mkdir(childDirectory);
    const cleanupAudit = collectObservedRootCleanupFailure();
    const registrations = new ObservedRootRegistrations({
      commands: catalogue,
      queries: catalogue,
      filesystem: new ReadOnlyFilesystemObserver(),
      productDataDirectory,
      managedArtifactDirectory: path.join(
        productDataDirectory,
        "managed-artifacts",
      ),
      cleanupFailureReporter: cleanupAudit.reporter,
      cleanupFailureFallback: cleanupAudit.reporter,
    });
    const parent = await registrations.create({
      displayName: "父位置",
      containerPath: observedDirectory,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    await expect(
      registrations.create({
        displayName: "子位置",
        containerPath: childDirectory,
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      }),
    ).resolves.toMatchObject({ configVersion: 1, status: "active" });

    const updated = await registrations.update({
      id: parent.id,
      expectedVersion: 1,
      displayName: "父位置（已更新）",
      readOnly: true,
      symlinkMode: "follow-file-links",
      allowedTargetRootIds: [],
    });
    expect(updated.configVersion).toBe(2);
    await expect(
      registrations.update({
        id: parent.id,
        expectedVersion: 1,
        displayName: "过期写入",
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      }),
    ).rejects.toThrow("文件位置已被其他设置修改");
    const revoked = await registrations.deactivate({
      id: parent.id,
      expectedVersion: 2,
    });
    expect(revoked).toMatchObject({ status: "revoked", configVersion: 3 });
    const unrelatedDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-unrelated-root-"),
    );
    cleanup.push(unrelatedDirectory);
    await expect(
      registrations.reconnect({
        id: parent.id,
        expectedVersion: 3,
        containerPath: unrelatedDirectory,
        readOnly: true,
      }),
    ).rejects.toThrow("不能把原文件位置重新指向无关路径");
    await expect(
      registrations.reconnect({
        id: parent.id,
        expectedVersion: 3,
        containerPath: observedDirectory,
        readOnly: true,
      }),
    ).resolves.toMatchObject({ status: "active", configVersion: 4 });
    catalogue.close();
  });

  it("revokes a root without deleting history and disables its dependent automation", async () => {
    const productDataDirectory = await preparedCatalogueRoot();
    cleanup.push(productDataDirectory);
    const observedDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-revoked-automation-root-"),
    );
    cleanup.push(observedDirectory);
    await writeFile(path.join(observedDirectory, "track.flac"), "content");

    const workflow = composeAssetRefresh(productDataDirectory, {});
    const registration = await workflow.observedRootRegistrations.create({
      displayName: "待停用的位置",
      containerPath: observedDirectory,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const { intent } = await workflow.enableAutomation({
      observedRootId: registration.id,
      relativeScope: ".",
      intervalMilliseconds: 60_000,
      acceptTrusted: true,
      runInitial: false,
    });
    const activeSource =
      await workflow.observedRootRegistrations.openActiveByteSource({
        registrationId: registration.id,
        relativePath: "track.flac",
      });
    try {
      expect(activeSource.logicalLocation).toBe(
        path.join(observedDirectory, "track.flac"),
      );
      await expect(activeSource.read()).resolves.toEqual(
        new TextEncoder().encode("content"),
      );
    } finally {
      await activeSource.close();
    }

    const revoked = await workflow.observedRootRegistrations.deactivate({
      id: registration.id,
      expectedVersion: registration.configVersion,
    });
    const repeated = await workflow.observedRootRegistrations.deactivate({
      id: registration.id,
      expectedVersion: revoked.configVersion,
    });

    expect(revoked).toMatchObject({ status: "revoked", configVersion: 2 });
    expect(repeated).toEqual(revoked);
    await expect(workflow.listAutomationIntents()).resolves.toEqual([
      expect.objectContaining({
        id: intent.id,
        enabled: false,
        disabledReason: "observed-root-revoked",
      }),
    ]);
    await expect(
      workflow.scanObservedScope({
        registrationId: registration.id,
        relativeScope: ".",
        acceptTrusted: true,
      }),
    ).rejects.toThrow("文件位置已停用");
    await expect(
      workflow.observedRootRegistrations.openActiveByteSource({
        registrationId: registration.id,
        relativePath: "track.flac",
      }),
    ).rejects.toThrow("文件位置已停用");
    await expect(
      workflow.triggerAutomation(intent.id, "scan-now"),
    ).rejects.toThrow("文件位置已停用");
    await expect(workflow.triggerDueAutomation()).resolves.toEqual([]);

    await workflow.close();
    const reopened = SqliteCatalogue.forProductData(productDataDirectory);
    await expect(reopened.listAutomationIntents()).resolves.toEqual([
      expect.objectContaining({
        id: intent.id,
        enabled: false,
        disabledReason: "observed-root-revoked",
      }),
    ]);
    reopened.close();
  });

  it("revokes every automation whose authorized target closure depends on the root", async () => {
    const productDataDirectory = await preparedCatalogueRoot();
    cleanup.push(productDataDirectory);
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-transitive-revocation-"),
    );
    cleanup.push(rootDirectory);
    const directoryA = path.join(rootDirectory, "a");
    const directoryB = path.join(rootDirectory, "b");
    const directoryC = path.join(rootDirectory, "c");
    await Promise.all(
      [directoryA, directoryB, directoryC].map(
        async (directory) => await mkdir(directory),
      ),
    );

    const workflow = composeAssetRefresh(productDataDirectory, {});
    const rootC = await workflow.observedRootRegistrations.create({
      displayName: "目标 C",
      containerPath: directoryC,
      readOnly: true,
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetRootIds: [],
    });
    const rootB = await workflow.observedRootRegistrations.create({
      displayName: "依赖 C 的 B",
      containerPath: directoryB,
      readOnly: true,
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetRootIds: [rootC.id],
    });
    const rootA = await workflow.observedRootRegistrations.create({
      displayName: "经由 B 依赖 C 的 A",
      containerPath: directoryA,
      readOnly: true,
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetRootIds: [rootB.id],
    });
    const intents = await Promise.all(
      [rootA, rootB, rootC].map(
        async (root) =>
          (
            await workflow.enableAutomation({
              observedRootId: root.id,
              relativeScope: ".",
              intervalMilliseconds: 60_000,
              acceptTrusted: true,
              runInitial: false,
            })
          ).intent,
      ),
    );

    await workflow.observedRootRegistrations.deactivate({
      id: rootC.id,
      expectedVersion: rootC.configVersion,
    });

    await expect(workflow.listAutomationIntents()).resolves.toEqual(
      expect.arrayContaining(
        intents.map((intent) =>
          expect.objectContaining({
            id: intent.id,
            enabled: false,
            disabledReason: "observed-root-revoked",
          }),
        ),
      ),
    );
    await expect(
      workflow.scanObservedScope({
        registrationId: rootA.id,
        relativeScope: ".",
        acceptTrusted: true,
      }),
    ).rejects.toThrow("允许的链接目标文件位置不可用");
    await expect(
      workflow.observedRootRegistrations.openActiveByteSource({
        registrationId: rootA.id,
        relativePath: "any-file.bin",
      }),
    ).rejects.toThrow("允许的链接目标文件位置不可用");
    await expect(
      workflow.scanObservedScope({
        registrationId: rootB.id,
        relativeScope: ".",
        acceptTrusted: true,
      }),
    ).rejects.toThrow("允许的链接目标文件位置不可用");
    await expect(
      workflow.observedRootRegistrations.openActiveByteSource({
        registrationId: rootB.id,
        relativePath: "any-file.bin",
      }),
    ).rejects.toThrow("允许的链接目标文件位置不可用");
    await expect(
      workflow.scanObservedScope({
        registrationId: rootC.id,
        relativeScope: ".",
        acceptTrusted: true,
      }),
    ).rejects.toThrow("文件位置已停用");
    await expect(
      workflow.observedRootRegistrations.openActiveByteSource({
        registrationId: rootC.id,
        relativePath: "any-file.bin",
      }),
    ).rejects.toThrow("文件位置已停用");

    await workflow.close();
  });

  it("atomically rejects an Automation Intent when a frozen target root is revoked between preflight and creation", async () => {
    const productDataDirectory = await preparedCatalogueRoot();
    cleanup.push(productDataDirectory);
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-automation-authorization-root-"),
    );
    const targetDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-automation-authorization-target-"),
    );
    cleanup.push(rootDirectory, targetDirectory);

    const workflow = composeAssetRefresh(productDataDirectory, {});
    const registrations = workflow.observedRootRegistrations;
    const target = await registrations.create({
      displayName: "自动刷新链接目标",
      containerPath: targetDirectory,
      readOnly: true,
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetRootIds: [],
    });
    const root = await registrations.create({
      displayName: "自动刷新根目录",
      containerPath: rootDirectory,
      readOnly: true,
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetRootIds: [target.id],
    });
    let enteredCreation: () => void;
    const creationEntered = new Promise<void>((resolve) => {
      enteredCreation = resolve;
    });
    let releaseCreation: () => void;
    const creationRelease = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
    const automation = new AssetRefreshAutomation(workflow, {
      executionQueries: catalogue,
      automationQueries: catalogue,
      automationCommands: {
        async createAutomationIntentForObservedRoot(input) {
          enteredCreation!();
          await creationRelease;
          return await catalogue.createAutomationIntentForObservedRoot(input);
        },
        releaseAutomationTrigger:
          catalogue.releaseAutomationTrigger.bind(catalogue),
        setAutomationIntentEnabled:
          catalogue.setAutomationIntentEnabled.bind(catalogue),
      },
      observedRootRegistrations: registrations,
      recognitionPolicyVersion: "composed-recognition-policy/1",
    });

    const enabling = automation.enableAutomation({
      observedRootId: root.id,
      relativeScope: ".",
      intervalMilliseconds: 60_000,
      acceptTrusted: true,
      runInitial: false,
    });
    await creationEntered;
    await registrations.deactivate({
      id: target.id,
      expectedVersion: target.configVersion,
    });
    releaseCreation!();

    await expect(enabling).rejects.toThrow("文件位置已停用或配置已变更");
    await expect(catalogue.listAutomationIntents()).resolves.toEqual([]);
    catalogue.close();
    await workflow.close();
  });

  it("quarantines malformed persisted Automation Intent configuration before it can trigger", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const insertIntent = database.prepare(
      `INSERT INTO automation_intents
        (id, scope_json, enabled, disabled_reason, interval_milliseconds,
         workflow_input_version, policy_references_json, accept_trusted, run_initial)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertIntent.run(
      "malformed-scope",
      "not-json",
      1,
      null,
      60_000,
      "asset-refresh-input/1",
      JSON.stringify(["policy/1"]),
      1,
      0,
    );
    insertIntent.run(
      "malformed-policy-references",
      JSON.stringify({ observedRootId: "root", relativeScope: "." }),
      1,
      null,
      60_000,
      "asset-refresh-input/1",
      "not-json",
      1,
      0,
    );
    database.close();

    const catalogue = SqliteCatalogue.forProductData(root);
    await expect(catalogue.listAutomationIntents()).resolves.toEqual([]);
    await expect(
      catalogue.inspectAutomationIntent("malformed-scope"),
    ).resolves.toBeUndefined();
    catalogue.close();

    const quarantined = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      quarantined
        .prepare(
          "SELECT id, enabled, disabled_reason FROM automation_intents ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "malformed-policy-references",
        enabled: 0,
        disabled_reason: "invalid-configuration",
      },
      {
        id: "malformed-scope",
        enabled: 0,
        disabled_reason: "invalid-configuration",
      },
    ]);
    quarantined.close();
  });

  it("scans only a bounded registered scope and freezes its structured root version", async () => {
    const productDataDirectory = await preparedCatalogueRoot();
    cleanup.push(productDataDirectory);
    const observedDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-registered-scan-"),
    );
    cleanup.push(observedDirectory);
    await writeFile(path.join(observedDirectory, "unknown.bin"), "content");
    const workflow = composeAssetRefresh(productDataDirectory, {});
    const registration = await workflow.observedRootRegistrations.create({
      displayName: "扫描位置",
      containerPath: observedDirectory,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });

    const result = await workflow.scanObservedScope({
      registrationId: registration.id,
      relativeScope: ".",
      acceptTrusted: false,
    });

    expect(result.execution.workflowInput).toMatchObject({
      observedRoots: [
        {
          version: "observed-root-snapshot/1",
          id: registration.id,
          configVersion: 1,
          containerPath: observedDirectory,
          readOnly: true,
          symlinkMode: "do-not-follow",
          allowedTargetRootIds: [],
        },
      ],
    });
    expect(result.execution.resolvedSelection?.filesystemScopes).toEqual([
      expect.objectContaining({
        root: observedDirectory,
        relativeScope: ".",
        observedRoot: expect.objectContaining({ id: registration.id }),
      }),
    ]);
    await workflow.close();
    const reopened = SqliteCatalogue.forProductData(productDataDirectory);
    await expect(
      reopened.inspectExecution(result.execution.id),
    ).resolves.toMatchObject({
      execution: {
        workflowInput: {
          observedRoots: [
            {
              id: registration.id,
              configVersion: 1,
              containerPath: observedDirectory,
            },
          ],
        },
        resolvedSelection: {
          filesystemScopes: [
            {
              relativeScope: ".",
              observedRoot: { id: registration.id, configVersion: 1 },
            },
          ],
        },
      },
    });
    reopened.close();
  });

  it("freezes registered alias spellings across an A→B→C target-root closure", async () => {
    const productDataDirectory = await preparedCatalogueRoot();
    cleanup.push(productDataDirectory);
    const sourceDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-linked-source-"),
    );
    const firstTarget = await mkdtemp(
      path.join(tmpdir(), "digital-linked-target-one-"),
    );
    const secondTarget = await mkdtemp(
      path.join(tmpdir(), "digital-linked-target-two-"),
    );
    const firstTargetAlias = `${firstTarget}-registered-alias`;
    const secondTargetAlias = `${secondTarget}-registered-alias`;
    cleanup.push(
      sourceDirectory,
      firstTarget,
      secondTarget,
      firstTargetAlias,
      secondTargetAlias,
    );
    await writeFile(path.join(secondTarget, "evidence.bin"), "evidence");
    await symlink(firstTarget, firstTargetAlias, "dir");
    await symlink(secondTarget, secondTargetAlias, "dir");
    await symlink(firstTargetAlias, path.join(sourceDirectory, "first"), "dir");
    await symlink(secondTargetAlias, path.join(firstTarget, "second"), "dir");
    const workflow = composeAssetRefresh(productDataDirectory, {});
    const registrations = workflow.observedRootRegistrations;
    const targetTwo = await registrations.create({
      displayName: "目标二",
      containerPath: secondTargetAlias,
      readOnly: true,
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetRootIds: [],
    });
    const targetOne = await registrations.create({
      displayName: "目标一",
      containerPath: firstTargetAlias,
      readOnly: true,
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetRootIds: [targetTwo.id],
    });
    const source = await registrations.create({
      displayName: "来源",
      containerPath: sourceDirectory,
      readOnly: true,
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetRootIds: [targetOne.id],
    });

    const result = await workflow.scanObservedScope({
      registrationId: source.id,
      relativeScope: ".",
      acceptTrusted: false,
    });

    expect(result.execution.snapshot.diagnostics).toBeUndefined();
    expect(result.execution.snapshot).toMatchObject({
      complete: true,
      files: [{ relativePath: "first/second/evidence.bin" }],
    });
    expect(result.execution.workflowInput?.observedRoots).toEqual([
      expect.objectContaining({
        id: source.id,
        authorizedTargetRoots: expect.arrayContaining([
          expect.objectContaining({
            id: targetOne.id,
            configVersion: 1,
            containerPath: firstTargetAlias,
          }),
          expect.objectContaining({
            id: targetTwo.id,
            configVersion: 1,
            containerPath: secondTargetAlias,
          }),
        ]),
      }),
    ]);
    await workflow.close();
  });

  it("does not reuse a prior observation after revocation and a new registration", async () => {
    const productDataDirectory = await preparedCatalogueRoot();
    cleanup.push(productDataDirectory);
    const observedDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-reconnect-evidence-"),
    );
    cleanup.push(observedDirectory);
    const original = path.join(observedDirectory, "original.flac");
    await writeFile(original, "audio");
    await link(original, path.join(observedDirectory, "hardlink.flac"));
    await symlink(original, path.join(observedDirectory, "alias.flac"));

    const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
    const filesystem = new ReadOnlyFilesystemObserver();
    const cleanupAudit = collectObservedRootCleanupFailure();
    const registrations = new ObservedRootRegistrations({
      commands: catalogue,
      queries: catalogue,
      filesystem,
      productDataDirectory,
      managedArtifactDirectory: path.join(
        productDataDirectory,
        "managed-artifacts",
      ),
      cleanupFailureReporter: cleanupAudit.reporter,
      cleanupFailureFallback: cleanupAudit.reporter,
    });
    const workflow = recoveryWorkflow(catalogue, {
      observedRootRegistrations: registrations,
      uniqueRecordIds: true,
      uniqueProposalIds: true,
    });
    const firstRoot = await registrations.create({
      displayName: "原始文件位置",
      containerPath: observedDirectory,
      readOnly: true,
      symlinkMode: "follow-file-links",
      allowedTargetRootIds: [],
    });

    const first = await workflow.scanObservedScope({
      registrationId: firstRoot.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const firstAccepted = (await catalogue.inspectExecution(first.execution.id))
      ?.accepted;
    expect(firstAccepted).toBeDefined();
    expect(firstAccepted?.artifacts).toHaveLength(1);
    expect(firstAccepted?.artifactAssociations).toHaveLength(1);
    expect(firstAccepted?.locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: `${observedDirectory}/original.flac`,
        }),
        expect.objectContaining({
          address: `${observedDirectory}/hardlink.flac`,
        }),
        expect.objectContaining({ address: `${observedDirectory}/alias.flac` }),
      ]),
    );

    await registrations.deactivate({
      id: firstRoot.id,
      expectedVersion: firstRoot.configVersion,
    });
    await expect(
      workflow.scanObservedScope({
        registrationId: firstRoot.id,
        relativeScope: ".",
        acceptTrusted: true,
      }),
    ).rejects.toThrow("文件位置已停用");

    const replacementRoot = await registrations.create({
      displayName: "重新登记的位置",
      containerPath: observedDirectory,
      readOnly: true,
      symlinkMode: "follow-file-links",
      allowedTargetRootIds: [],
    });
    const second = await workflow.scanObservedScope({
      registrationId: replacementRoot.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const [current] = await catalogue.findAcceptedForSubjects([
      firstAccepted!.entity.id,
    ]);

    expect(second.execution).toMatchObject({
      outcome: "accepted",
      acceptedAssetId: firstAccepted?.entity.id,
    });
    expect(second.execution).not.toHaveProperty("reusedExecutionId");
    expect(current?.accepted.artifacts).toHaveLength(2);
    expect(current?.accepted.artifacts.map((artifact) => artifact.id)).toEqual(
      expect.arrayContaining(
        firstAccepted?.artifacts.map((artifact) => artifact.id) ?? [],
      ),
    );
    expect(current?.accepted.locations).toHaveLength(6);
    catalogue.close();
  });

  it("keeps object-identity aliases in one format boundary and one Artifact Revision", async () => {
    const productDataDirectory = await preparedCatalogueRoot();
    cleanup.push(productDataDirectory);
    const observedDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-format-alias-revision-"),
    );
    cleanup.push(observedDirectory);
    const original = path.join(observedDirectory, "original.container");
    await writeFile(original, "format bytes");
    await link(original, path.join(observedDirectory, "hardlink.container"));
    await symlink(original, path.join(observedDirectory, "alias.container"));

    const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
    const filesystem = new ReadOnlyFilesystemObserver();
    const cleanupAudit = collectObservedRootCleanupFailure();
    const registrations = new ObservedRootRegistrations({
      commands: catalogue,
      queries: catalogue,
      filesystem,
      productDataDirectory,
      managedArtifactDirectory: path.join(
        productDataDirectory,
        "managed-artifacts",
      ),
      cleanupFailureReporter: cleanupAudit.reporter,
      cleanupFailureFallback: cleanupAudit.reporter,
    });
    const workflow = recoveryWorkflow(catalogue, {
      observedRootRegistrations: registrations,
      includeFormatFacts: true,
      uniqueRecordIds: true,
      uniqueProposalIds: true,
    });
    const root = await registrations.create({
      displayName: "格式别名位置",
      containerPath: observedDirectory,
      readOnly: true,
      symlinkMode: "follow-file-links",
      allowedTargetRootIds: [],
    });

    const result = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const items =
      (await catalogue.inspectExecution(result.execution.id))
        ?.workItemInspections ?? [];

    expect(items).toHaveLength(1);
    expect(items[0]?.workItem.relativePaths).toEqual([
      "alias.container",
      "hardlink.container",
      "original.container",
    ]);
    expect(items[0]?.accepted?.artifacts).toHaveLength(1);
    expect(items[0]?.accepted?.artifactRevisions).toHaveLength(1);
    expect(items[0]?.accepted?.locations).toHaveLength(3);

    const unchanged = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });

    expect(unchanged.execution.outcome).toBe("no-change");
    expect(unchanged.sourceRecords).toEqual([]);
    catalogue.close();
  });

  it("does not reuse snapshot-local object evidence across separately registered root aliases", async () => {
    const productDataDirectory = await preparedCatalogueRoot();
    cleanup.push(productDataDirectory);
    const observedDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-cross-root-alias-"),
    );
    const aliasParent = await mkdtemp(
      path.join(tmpdir(), "digital-cross-root-alias-parent-"),
    );
    const aliasDirectory = path.join(aliasParent, "same-files");
    cleanup.push(observedDirectory, aliasParent);
    await writeFile(path.join(observedDirectory, "work.container"), "bytes");
    await symlink(observedDirectory, aliasDirectory, "dir");

    const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
    const filesystem = new ReadOnlyFilesystemObserver();
    const cleanupAudit = collectObservedRootCleanupFailure();
    const registrations = new ObservedRootRegistrations({
      commands: catalogue,
      queries: catalogue,
      filesystem,
      productDataDirectory,
      managedArtifactDirectory: path.join(
        productDataDirectory,
        "managed-artifacts",
      ),
      cleanupFailureReporter: cleanupAudit.reporter,
      cleanupFailureFallback: cleanupAudit.reporter,
    });
    const workflow = recoveryWorkflow(catalogue, {
      observedRootRegistrations: registrations,
      includeFormatFacts: true,
      uniqueRecordIds: true,
      uniqueProposalIds: true,
    });
    const direct = await registrations.create({
      displayName: "直接位置",
      containerPath: observedDirectory,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const alias = await registrations.create({
      displayName: "别名位置",
      containerPath: aliasDirectory,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });

    const first = await workflow.scanObservedScope({
      registrationId: direct.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const firstAccepted = (await catalogue.inspectExecution(first.execution.id))
      ?.workItemInspections?.[0]?.accepted;
    const second = await workflow.scanObservedScope({
      registrationId: alias.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const secondAccepted = (
      await catalogue.inspectExecution(second.execution.id)
    )?.workItemInspections?.[0]?.accepted;

    expect(firstAccepted).toBeDefined();
    expect(secondAccepted?.entity.id).not.toBe(firstAccepted?.entity.id);
    expect(secondAccepted?.artifacts).not.toEqual(firstAccepted?.artifacts);
    expect(secondAccepted?.artifactRevisions).not.toEqual(
      firstAccepted?.artifactRevisions,
    );
    expect(secondAccepted?.locations).toEqual([
      expect.objectContaining({
        address: path.join(aliasDirectory, "work.container"),
      }),
    ]);
    await expect(catalogue.listCurrentCatalogue()).resolves.toHaveLength(2);
    catalogue.close();
  });

  it("reuses a cross-root observed Artifact only through an explicit durable identity capability", async () => {
    const catalogue = await createCatalogue();
    const durableCapability = {
      capabilityId: "test.durable-observed-identity",
      capabilityVersion: "1",
      contractVersion: "1",
    } as const;
    const workflow = recoveryWorkflow(catalogue, {
      uniqueRecordIds: true,
      uniqueProposalIds: true,
      filesystemOptions: {
        capability: {
          capabilityId: "test.durable-observer",
          capabilityVersion: "1",
          contractVersion: "1",
        },
        objectIdentityContract: {
          kind: "durable",
          capability: durableCapability,
        },
        async observe({ scope }) {
          return {
            id: `durable-${scope.logicalLocation}`,
            root: scope.logicalLocation,
            complete: true,
            excluded: [],
            files: [
              {
                relativePath: "work.bin",
                size: 4,
                modifiedAt: "2026-08-02T00:00:00.000Z",
                objectIdentity: {
                  version: "filesystem-object-identity/2",
                  kind: "durable",
                  capability: durableCapability,
                  // 适配器拥有这个可感知世代的不透明令牌。
                  value: "opaque-object/generation-1",
                },
              },
            ],
            observedAt: "2026-08-02T00:00:00.000Z",
          };
        },
      },
    });

    const first = await workflow.scanObservedScope({
      registrationId: "durable-left",
      relativeScope: ".",
      acceptTrusted: true,
    });
    const second = await workflow.scanObservedScope({
      registrationId: "durable-right",
      relativeScope: ".",
      acceptTrusted: true,
    });

    expect(first.accepted?.entity.id).toEqual(expect.any(String));
    // 第二个根新增了不同的已观察位置，因此其执行是可审计的重新评估。不过持久能力仍会
    // 跨根边界复用同一个具体产物和当前资产。
    expect(second.execution).toMatchObject({
      outcome: "accepted",
      acceptedAssetId: first.accepted?.entity.id,
    });
    expect(second.execution).not.toHaveProperty("reusedExecutionId");
    expect(second.accepted?.artifacts).toEqual(first.accepted?.artifacts);
    expect(
      (await catalogue.inspectExecution(second.execution.id))?.execution
        .compatibility.capabilityCoordinates,
    ).toEqual(expect.arrayContaining(["test.durable-observed-identity@1/1"]));
    catalogue.close();
  });

  it("does not reuse a durable identity when its opaque generation token changes", async () => {
    const catalogue = await createCatalogue();
    const durableCapability = {
      capabilityId: "test.durable-observed-identity",
      capabilityVersion: "1",
      contractVersion: "1",
    } as const;
    const workflow = recoveryWorkflow(catalogue, {
      uniqueRecordIds: true,
      uniqueProposalIds: true,
      filesystemOptions: {
        capability: {
          capabilityId: "test.durable-observer",
          capabilityVersion: "1",
          contractVersion: "1",
        },
        objectIdentityContract: {
          kind: "durable",
          capability: durableCapability,
        },
        async observe({ scope }) {
          const generation = scope.root.id === "generation-one" ? "one" : "two";
          return {
            id: `durable-${generation}`,
            root: scope.logicalLocation,
            complete: true,
            excluded: [],
            files: [
              {
                relativePath: "work.bin",
                size: 4,
                modifiedAt: "2026-08-02T00:00:00.000Z",
                objectIdentity: {
                  version: "filesystem-object-identity/2",
                  kind: "durable",
                  capability: durableCapability,
                  // 不透明适配器令牌可以包含类似设备/inode 的坐标，但其承诺中必须包含世代。
                  value: `opaque-object/same-device-inode/generation-${generation}`,
                },
              },
            ],
            observedAt: "2026-08-02T00:00:00.000Z",
          };
        },
      },
    });

    const first = await workflow.scanObservedScope({
      registrationId: "generation-one",
      relativeScope: ".",
      acceptTrusted: true,
    });
    const second = await workflow.scanObservedScope({
      registrationId: "generation-two",
      relativeScope: ".",
      acceptTrusted: true,
    });

    expect(first.accepted?.entity.id).toEqual(expect.any(String));
    expect(second.execution.outcome).toBe("accepted");
    expect(second.execution).not.toHaveProperty("reusedExecutionId");
    expect(second.accepted?.entity.id).not.toBe(first.accepted?.entity.id);
    catalogue.close();
  });

  it("fails closed when exact observed Artifact evidence has multiple current Asset owners", async () => {
    const catalogue = await createCatalogue();
    const artifactId = "artifact_exact-observed-object";
    for (const assetId of ["asset-one", "asset-two"]) {
      const record = sourceRecordFor(assetId);
      const accepted = acceptedFor(assetId, record.id);
      const contradictory: AcceptedRecognition = {
        ...accepted,
        artifacts: [{ id: artifactId }],
        locations: accepted.locations.map((location) => ({
          ...location,
          artifactId,
          address: `/observed/${assetId}`,
        })),
        artifactRevisions: accepted.artifactRevisions.map((revision) => ({
          ...revision,
          artifactId,
        })),
        artifactAssociations: accepted.artifactAssociations.map(
          (association) => ({
            ...association,
            artifactId,
            role: "asset.material-delivered" as const,
          }),
        ),
      };
      const executionId = `exact-evidence-${assetId}`;
      await catalogue.createExecution(executionFor(executionId));
      await retainSourceRecords(catalogue, executionId, [record]);
      await acceptRecognition(catalogue, {
        execution: acceptedExecutionFor(executionId, assetId),
        accepted: contradictory,
      });
    }

    await expect(
      catalogue.findCurrentAcceptedForObservedArtifacts({
        artifactIds: [artifactId],
      }),
    ).resolves.toEqual({
      status: "ambiguous",
      assetIds: ["asset-one", "asset-two"],
    });
    catalogue.close();
  });

  it("rejects unsafe root paths and treats a missing registered root as local degradation", async () => {
    const { root: productDataDirectory, catalogue } =
      await createCatalogueWithRoot();
    const cleanupAudit = collectObservedRootCleanupFailure();
    const registrations = new ObservedRootRegistrations({
      commands: catalogue,
      queries: catalogue,
      filesystem: new ReadOnlyFilesystemObserver(),
      productDataDirectory,
      managedArtifactDirectory: path.join(
        productDataDirectory,
        "managed-artifacts",
      ),
      cleanupFailureReporter: cleanupAudit.reporter,
      cleanupFailureFallback: cleanupAudit.reporter,
    });
    await expect(
      registrations.create({
        displayName: "相对路径",
        containerPath: "relative/path",
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      }),
    ).rejects.toThrow("容器内绝对路径");
    await expect(
      registrations.create({
        displayName: "可写意图",
        containerPath: productDataDirectory,
        readOnly: false,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      } as never),
    ).rejects.toThrow("必须明确登记为只读");
    await expect(
      registrations.create({
        displayName: "产品数据",
        containerPath: productDataDirectory,
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      }),
    ).rejects.toThrow("不能与产品数据或托管产物目录重叠");
    const productAlias = path.join(
      await mkdtemp(path.join(tmpdir(), "digital-product-alias-")),
      "alias",
    );
    cleanup.push(path.dirname(productAlias));
    await symlink(productDataDirectory, productAlias, "dir");
    await expect(
      registrations.create({
        displayName: "产品数据链接别名",
        containerPath: productAlias,
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      }),
    ).rejects.toThrow("不能与产品数据或托管产物目录重叠");
    const observedDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-degraded-root-"),
    );
    cleanup.push(observedDirectory);
    const registration = await registrations.create({
      displayName: "稍后卸载",
      containerPath: observedDirectory,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    await expect(
      registrations.resolveActiveScope({
        registrationId: registration.id,
        relativeScope: "../escape",
      }),
    ).rejects.toThrow("不能越过登记根目录");
    await expect(
      registrations.resolveActiveScope({
        registrationId: registration.id,
        relativeScope: productDataDirectory,
      }),
    ).rejects.toThrow("必须是相对路径");
    await rm(observedDirectory, { recursive: true });
    await expect(
      registrations.resolveActiveScope({
        registrationId: registration.id,
        relativeScope: ".",
      }),
    ).rejects.toThrow("当前缺失、不可读或范围越界");
    await expect(registrations.get(registration.id)).resolves.toEqual(
      registration,
    );
    await expect(catalogue.listExecutions()).resolves.toEqual([]);
    catalogue.close();
  });

  it("uses new root configuration immediately but interrupts recovery of an older frozen version", async () => {
    const productDataDirectory = await preparedCatalogueRoot();
    cleanup.push(productDataDirectory);
    const observedDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-frozen-root-"),
    );
    cleanup.push(observedDirectory);
    await writeFile(path.join(observedDirectory, "unknown.bin"), "content");
    const workflow = composeAssetRefresh(productDataDirectory, {});
    const registration = await workflow.observedRootRegistrations.create({
      displayName: "冻结版本",
      containerPath: observedDirectory,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    let executionId = "";
    await expect(
      workflow.scanObservedScope({
        registrationId: registration.id,
        relativeScope: ".",
        acceptTrusted: false,
        onExecutionStarted(execution) {
          executionId = execution.id;
        },
        onHostCheckpoint() {
          throw new Error("模拟旧进程退出");
        },
      }),
    ).rejects.toThrow("模拟旧进程退出");
    await workflow.observedRootRegistrations.update({
      id: registration.id,
      expectedVersion: 1,
      displayName: "新版本",
      readOnly: true,
      symlinkMode: "follow-file-links",
      allowedTargetRootIds: [],
    });

    await expect(workflow.resume({ executionId })).resolves.toMatchObject({
      execution: {
        status: "failed",
        outcome: "interrupted",
        reason: expect.stringContaining("冻结文件位置当前不可用或版本已变更"),
      },
    });
    await workflow.close();
  });

  it("interrupts recovery when a frozen registered target alias is repointed", async () => {
    const productDataDirectory = await preparedCatalogueRoot();
    cleanup.push(productDataDirectory);
    const sourceDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-frozen-alias-source-"),
    );
    const targetDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-frozen-alias-target-"),
    );
    const outsideDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-frozen-alias-outside-"),
    );
    const targetAlias = `${targetDirectory}-registered-alias`;
    cleanup.push(
      sourceDirectory,
      targetDirectory,
      outsideDirectory,
      targetAlias,
    );
    await writeFile(path.join(targetDirectory, "evidence.bin"), "inside");
    await writeFile(
      path.join(outsideDirectory, "evidence.bin"),
      "outside-must-not-be-observed",
    );
    await symlink(targetDirectory, targetAlias, "dir");
    await symlink(
      path.join(targetAlias, "evidence.bin"),
      path.join(sourceDirectory, "linked-evidence.bin"),
    );
    const workflow = composeAssetRefresh(productDataDirectory, {});
    const registrations = workflow.observedRootRegistrations;
    const target = await registrations.create({
      displayName: "冻结目标别名",
      containerPath: targetAlias,
      readOnly: true,
      symlinkMode: "follow-file-links",
      allowedTargetRootIds: [],
    });
    const source = await registrations.create({
      displayName: "冻结来源",
      containerPath: sourceDirectory,
      readOnly: true,
      symlinkMode: "follow-file-links",
      allowedTargetRootIds: [target.id],
    });
    let executionId = "";
    await expect(
      workflow.scanObservedScope({
        registrationId: source.id,
        relativeScope: ".",
        acceptTrusted: false,
        onExecutionStarted(execution) {
          executionId = execution.id;
        },
        onHostCheckpoint() {
          throw new Error("模拟别名重绑定前的进程退出");
        },
      }),
    ).rejects.toThrow("模拟别名重绑定前的进程退出");
    await rm(targetAlias);
    await symlink(outsideDirectory, targetAlias, "dir");

    const resumed = await workflow.resume({ executionId });
    expect(resumed.execution).toMatchObject({
      status: "failed",
      outcome: "interrupted",
      reason: expect.stringContaining("文件位置当前"),
    });
    expect(resumed.execution.snapshot).toMatchObject({
      root: sourceDirectory,
      files: [{ relativePath: "linked-evidence.bin", size: 6 }],
    });
    await workflow.close();
  });

  it("closes an automation workflow exactly once when its initial poll fails", async () => {
    let closes = 0;
    const failure = new Error("initial poll failed");
    const host = composeOwnedAutomationHost({
      async recoverRunningExecutions() {
        throw failure;
      },
      async triggerDueAutomation() {
        return [];
      },
      close() {
        closes += 1;
      },
    });

    await expect(host.start()).rejects.toBe(failure);
    await expect(host.close()).rejects.toBe(failure);
    await expect(host.close()).rejects.toBe(failure);
    expect(closes).toBe(1);
  });

  it("waits for an owned workflow lifecycle drain before resolving close", async () => {
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    let signalCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      signalCloseStarted = resolve;
    });
    let closes = 0;
    const host = composeOwnedAutomationHost({
      async recoverRunningExecutions() {
        return [];
      },
      async triggerDueAutomation() {
        return [];
      },
      close() {
        closes += 1;
        signalCloseStarted();
        return drain;
      },
    });

    const closing = host.close();
    expect(host.close()).toBe(closing);
    await closeStarted;
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseDrain();
    await closing;
    expect(closes).toBe(1);
  });

  it("releases a product-data connection for a later catalogue instance", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution(execution());
    catalogue.close();

    const later = SqliteCatalogue.forProductData(root);
    await expect(later.inspectExecution("execution")).resolves.toMatchObject({
      execution: { id: "execution" },
    });
    later.close();
  });

  it("is safe to close twice and lazily reopen the same adapter", async () => {
    const catalogue = await createCatalogue();
    await catalogue.createExecution(execution());
    catalogue.close();
    catalogue.close();
    await expect(
      catalogue.inspectExecution("execution"),
    ).resolves.toMatchObject({ execution: { id: "execution" } });
    catalogue.close();
  });

  it("refuses a blank product-data database until independent schema preparation occurs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-unprepared-"));
    cleanup.push(root);
    const catalogue = SqliteCatalogue.forProductData(root);

    await expect(catalogue.listExecutions()).rejects.toThrow(
      "SQLite catalogue schema is not prepared",
    );
    catalogue.close();
  });

  it("reopens a valid versioned Workflow Execution audit", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution(execution());
    catalogue.close();

    const reopened = SqliteCatalogue.forProductData(root);
    await expect(reopened.inspectExecution("execution")).resolves.toMatchObject(
      {
        execution: {
          id: "execution",
          status: "running",
          stage: "recognition",
          sourceRecordIds: [],
        },
      },
    );
    reopened.close();
  });

  it.each([
    {
      name: "unknown audit version",
      mutate: (database: DatabaseSync) => {
        database
          .prepare("UPDATE workflow_executions SET audit_json = ? WHERE id = ?")
          .run(
            JSON.stringify({
              version: "workflow-execution-audit/unknown",
              payload: {},
            }),
            "execution",
          );
      },
      message: "unknown version",
    },
    {
      name: "malformed audit envelope",
      mutate: (database: DatabaseSync) => {
        database
          .prepare("UPDATE workflow_executions SET audit_json = ? WHERE id = ?")
          .run("not-json", "execution");
      },
      message: "malformed",
    },
    {
      name: "audit and column conflict",
      mutate: (database: DatabaseSync) => {
        database
          .prepare("UPDATE workflow_executions SET status = ? WHERE id = ?")
          .run("completed", "execution");
      },
      message: "conflicts with persisted columns",
    },
  ])("rejects a reopened $name", async ({ mutate, message }) => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution(execution());
    catalogue.close();

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      mutate(database);
    } finally {
      database.close();
    }

    const reopened = SqliteCatalogue.forProductData(root);
    await expect(reopened.inspectExecution("execution")).rejects.toThrow(
      message,
    );
    reopened.close();
  });

  it("prepares a disposable WAL catalogue and reads its current accepted asset", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution({
      ...executionFor("adoption-preview-owner"),
      status: "completed",
      stage: "completed",
      outcome: "proposal",
    });
    await catalogue.saveChangeImpactPreview({
      ...attentionPreview("adoption-preview-owner"),
      id: "adoption-sibling-preview",
    });
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [sourceRecord()]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });
    await expect(
      catalogue.inspectChangeImpactPreview("adoption-sibling-preview"),
    ).resolves.toMatchObject({ status: "stale" });
    await expect(catalogue.listCurrentCatalogue()).resolves.toMatchObject([
      {
        entity: { id: "asset", kind: "digital-asset" },
        recognitionSourceAssociation: {
          sourceIdentity: "source",
          nativeAddress: "https://source.example/work",
        },
        metadata: [{ property: "asset.title", value: "Work" }],
      },
    ]);

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      await expect(
        SqliteCatalogue.inspectProductionReadiness({
          productDataDirectory: root,
        }),
      ).resolves.toMatchObject({ state: "ready" });
      const audit = database
        .prepare("SELECT audit_json FROM workflow_executions WHERE id = ?")
        .get("execution") as { readonly audit_json: string };
      expect(JSON.parse(audit.audit_json)).toMatchObject({
        version: "workflow-execution-audit/1",
        payload: { id: "execution", outcome: "accepted" },
      });
    } finally {
      database.close();
    }
    catalogue.close();
  });

  it("keeps an observed directory package in the current catalogue without inventing a file observation", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [sourceRecord()]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    database.exec(`
      INSERT INTO observed_root_registrations (
        id, display_name, container_path, canonical_path, status, config_version,
        read_only, symlink_mode, allowed_target_root_ids_json
      ) VALUES (
        'package-root', 'Package root', '/observed', '/observed', 'active', 1,
        1, 'do-not-follow', '[]'
      );
      INSERT INTO artifacts (id) VALUES ('package-artifact');
      INSERT INTO locations (id, artifact_id, address, kind)
        VALUES ('package-location', 'package-artifact', '/observed/movie', 'observed');
      INSERT INTO artifact_associations (
        id, target_kind, target_entity_id, subject_id, artifact_id, role,
        source_record_ids_json
      ) VALUES (
        'package-association', 'entity', 'asset', 'asset', 'package-artifact',
        'asset.material-delivered', '[]'
      );
      INSERT INTO current_file_observation_supports (
        location_id, observed_root_id, observed_root_version,
        observed_root_path, authorized_targets_json
      ) VALUES (
        'package-location', 'package-root', 1, '/observed', '[]'
      );
    `);
    database.close();

    await expect(catalogue.listCurrentCatalogue()).resolves.toMatchObject([
      {
        entity: { id: "asset" },
        locations: expect.arrayContaining([
          expect.objectContaining({
            id: "package-location",
            address: "/observed/movie",
          }),
        ]),
      },
    ]);
    catalogue.close();
  });

  it("pages each current accepted asset once without replaying Workflow History", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    for (let index = 0; index < 128; index += 1) {
      const id = `older-history-${String(index).padStart(3, "0")}`;
      await catalogue.createExecution({
        ...executionFor(id),
        status: "completed",
        stage: "completed",
        outcome: "no-change",
      });
    }
    for (const assetId of ["alpha", "beta"] as const) {
      const executionId = `execution-${assetId}`;
      const record = sourceRecordFor(assetId);
      await catalogue.createExecution(executionFor(executionId));
      await retainSourceRecords(catalogue, executionId, [record]);
      await acceptRecognition(catalogue, {
        execution: acceptedExecutionFor(executionId, assetId),
        accepted: acceptedFor(assetId, record.id),
      });
    }
    // alpha 的后续审计记录绝不能凭空生成第二个当前目录项目。
    // 当前已接受主体仍是唯一权威。
    await catalogue.createExecution({
      ...executionFor("history-alpha"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      acceptedAssetId: "alpha",
    });

    catalogue.close();
    // 历史审计刻意不可读。当前目录没有理由检查它：目录权威来自保留的当前头部。
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      database
        .prepare("UPDATE workflow_executions SET audit_json = ? WHERE id = ?")
        .run("not-json", "older-history-000");
    } finally {
      database.close();
    }

    const reopened = SqliteCatalogue.forProductData(root);
    const first = await reopened.listCurrentCataloguePage({ limit: 1 });
    expect(first.items.map((item) => item.entity.id)).toEqual(["alpha"]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await reopened.listCurrentCataloguePage({
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.entity.id)).toEqual(["beta"]);
    expect(second.nextCursor).toBeUndefined();
    reopened.close();
  });

  it("batch-hydrates one hundred Current Catalogue assets with a fixed query bound", async () => {
    const catalogue = await createCatalogue();
    for (let index = 0; index < 100; index += 1) {
      const assetId = `bounded-catalogue-${String(index).padStart(3, "0")}`;
      const executionId = `execution-${assetId}`;
      const record = sourceRecordFor(assetId);
      await catalogue.createExecution(executionFor(executionId));
      await retainSourceRecords(catalogue, executionId, [record]);
      await acceptRecognition(catalogue, {
        execution: acceptedExecutionFor(executionId, assetId),
        accepted: acceptedFor(assetId, record.id),
      });
    }

    // 先初始化惰性连接，之后只观察两次页面读取。
    await catalogue.listCurrentCataloguePage({ limit: 1 });
    const nativeDatabase = (
      catalogue as unknown as { readonly database: DatabaseSync }
    ).database;
    let selectStatements = 0;
    nativeDatabase.setAuthorizer((actionCode) => {
      if (actionCode === sqliteConstants.SQLITE_SELECT) selectStatements += 1;
      return sqliteConstants.SQLITE_OK;
    });
    const countPage = async (limit: number) => {
      selectStatements = 0;
      const page = await catalogue.listCurrentCataloguePage({ limit });
      return { page, selectStatements };
    };

    const one = await countPage(1);
    const hundred = await countPage(100);
    expect(one.page.items).toHaveLength(1);
    expect(hundred.page.items).toHaveLength(100);
    expect(hundred.selectStatements).toBeLessThanOrEqual(
      one.selectStatements + 4,
    );
    catalogue.close();
  });

  it("当前目录先筛生效数字资产再按可见项分页", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    for (const assetId of ["a", "b", "c", "d", "e", "f"] as const) {
      const executionId = `pagination-${assetId}`;
      const record = sourceRecordFor(executionId);
      await catalogue.createExecution(executionFor(executionId));
      await retainSourceRecords(catalogue, executionId, [record]);
      await acceptRecognition(catalogue, {
        execution: acceptedExecutionFor(executionId, assetId),
        accepted: acceptedFor(assetId, record.id),
      });
    }
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      // 模拟已迁移的冲突和普通实体，目录读取只能公开 c/e/f 三个有效资产。
      database
        .prepare(
          `INSERT INTO entity_kind_assertions
             (id, entity_id, kind, basis, source_record_ids_json)
           VALUES ('pagination-a-person', 'a', 'person', 'legacy-migration', '[]')`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO entity_kind_decisions
             (id, entity_id, selected_kind, basis, replaces_decision_id, actor_id, operation)
           VALUES ('pagination-b-person', 'b', 'person', 'manual', NULL, 'user:甲', 'select')`,
        )
        .run();
      database
        .prepare(
          "UPDATE entity_kind_assertions SET basis = 'source' WHERE entity_id = 'd'",
        )
        .run();
      const cAssociation = database
        .prepare(
          `SELECT source_identity, native_address
             FROM source_associations WHERE subject_id = 'c'`,
        )
        .get() as {
        readonly source_identity: string;
        readonly native_address: string;
      };
      const cHead = {
        source_identity: cAssociation.source_identity,
        native_address: cAssociation.native_address,
        coverage_id: "coverage-1",
        source_record_id: "record-pagination-c",
      };
      database
        .prepare(
          `INSERT INTO source_lineage_heads
             (subject_id, source_identity, native_address, coverage_id, source_record_id)
           VALUES ('c', ?, ?, ?, ?)`,
        )
        .run(
          cHead.source_identity,
          cHead.native_address,
          cHead.coverage_id,
          cHead.source_record_id,
        );
      // 已结束的来源冲突必须保留历史，却不能让 hydration 把恢复后的资产漏掉。
      database
        .prepare(
          `INSERT INTO entity_kind_assertions
             (id, entity_id, kind, basis, source_record_ids_json)
           VALUES ('pagination-c-ended-person', 'c', 'person', 'source', ?)`,
        )
        .run(JSON.stringify([cHead.source_record_id]));
      database
        .prepare(
          `INSERT INTO entity_kind_source_supports
             (id, entity_id, source_subject_id, source_identity, native_address,
              coverage_id, source_record_id, assertion_id, predecessor_id, operation)
           VALUES ('pagination-c-ended-support', 'c', 'c', ?, ?, ?, ?,
                   'pagination-c-ended-person', NULL, 'assert'),
                  ('pagination-c-ended-retraction', 'c', 'c', ?, ?, ?, ?,
                   NULL, 'pagination-c-ended-support', 'retract')`,
        )
        .run(
          cHead.source_identity,
          cHead.native_address,
          cHead.coverage_id,
          cHead.source_record_id,
          cHead.source_identity,
          cHead.native_address,
          cHead.coverage_id,
          cHead.source_record_id,
        );
    } finally {
      database.close();
    }
    const first = await catalogue.listCurrentCataloguePage({ limit: 2 });
    expect(first.items.map((item) => item.entity.id)).toEqual(["c", "e"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await catalogue.listCurrentCataloguePage({
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.entity.id)).toEqual(["f"]);
    expect(second.nextCursor).toBeUndefined();
    catalogue.close();
  });

  it("pages recent Workflow History without rebuilding older audit records", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    for (let index = 0; index < 125; index += 1) {
      const id = `history-${String(index).padStart(3, "0")}`;
      await catalogue.createExecution({
        ...executionFor(id),
        status: "completed",
        stage: "completed",
        outcome: "no-change",
      });
    }
    const acceptedRecord = sourceRecordFor("history-accepted");
    const acceptedState = acceptedFor("history-accepted", acceptedRecord.id);
    await catalogue.createExecution(executionFor("history-125"));
    await retainSourceRecords(catalogue, "history-125", [acceptedRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecutionFor("history-125", "history-accepted"),
      accepted: acceptedState,
    });

    const proposalRecord = sourceRecordFor("history-proposal");
    const proposalState = acceptedFor("history-proposal", proposalRecord.id);
    await catalogue.createExecution(executionFor("history-126"));
    await retainSourceRecords(catalogue, "history-126", [proposalRecord]);
    const proposalBaseline = (await catalogue.inspectExecution("history-126"))!
      .execution;
    await catalogue.finishExecutionWithProposal(
      proposalBaseline,
      {
        ...proposalBaseline,
        status: "completed",
        stage: "completed",
        outcome: "proposal",
        proposalId: proposalState.proposal.id,
      },
      proposalState.proposal,
    );
    await catalogue.saveChangeImpactPreview({
      ...attentionPreview("history-126"),
      id: "history-preview",
      proposal: proposalState.proposal,
    });

    const latestRecord = sourceRecordFor("history-latest");
    await catalogue.createExecution(executionFor("history-127"));
    await retainSourceRecords(catalogue, "history-127", [latestRecord]);
    await catalogue.createSourceRefreshRun({
      executionId: "history-127",
      run: {
        id: "history-run",
        initiatedBy: "history-test",
        initiatedAt: "2026-08-02T00:00:00.000Z",
        requestedSelection: {
          subjectId: acceptedState.entity.id,
          sourceAssociationId: acceptedState.recognitionSourceAssociation.id,
          sourceIdentity:
            acceptedState.recognitionSourceAssociation.sourceIdentity,
          nativeAddress:
            acceptedState.recognitionSourceAssociation.nativeAddress,
          selectors: [{ kind: "metadata-property", property: "asset.title" }],
        },
        reviewPolicy: "automatic",
        baselineLineageHeads: [
          {
            sourceIdentity:
              acceptedState.recognitionSourceAssociation.sourceIdentity,
            nativeAddress:
              acceptedState.recognitionSourceAssociation.nativeAddress,
            coverageId: acceptedRecord.coverage.id,
            sourceRecordId: acceptedRecord.id,
          },
        ],
      },
    });
    const latestBaseline = (await catalogue.inspectExecution("history-127"))!
      .execution;
    await catalogue.finishExecution(latestBaseline, {
      ...latestBaseline,
      status: "completed",
      stage: "completed",
      outcome: "no-change",
      sourceRefreshRunIds: ["history-run"],
    });
    catalogue.close();

    // 旧的格式错误审计仍属于永久历史，但不得让有界第一页重建所有更早历史记录。
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      database
        .prepare("UPDATE workflow_executions SET audit_json = ? WHERE id = ?")
        .run("not-json", "history-000");
    } finally {
      database.close();
    }

    const reopened = SqliteCatalogue.forProductData(root);
    const first = await reopened.listWorkflowHistoryPage({ limit: 3 });
    expect(first.items).toMatchObject([
      {
        execution: {
          id: "history-127",
          sourceRefreshRunIds: ["history-run"],
        },
        sourceRecords: [{ id: latestRecord.id }],
        sourceRefreshRuns: [{ id: "history-run" }],
      },
      {
        execution: { id: "history-126", outcome: "proposal" },
        proposals: [{ id: proposalState.proposal.id }],
        resultReferences: {
          proposalIds: [proposalState.proposal.id],
          changeImpactPreviewIds: ["history-preview"],
        },
        changeImpactPreviews: [{ id: "history-preview" }],
      },
      {
        execution: { id: "history-125", outcome: "accepted" },
        resultReferences: {
          acceptedAssetIds: [acceptedState.entity.id],
          recognitionDecisionIds: [acceptedState.recognitionDecision.id],
          sourceAssociationIds: [acceptedState.recognitionSourceAssociation.id],
        },
      },
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await reopened.listWorkflowHistoryPage({
      limit: 3,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.execution.id)).toEqual([
      "history-124",
      "history-123",
      "history-122",
    ]);
    reopened.close();
  });

  it("batch-hydrates two hundred History work items with a fixed query bound", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const proposals = ["bounded-history-a", "bounded-history-b"].flatMap(
      (executionId) =>
        Array.from({ length: 100 }, (_, index) =>
          acceptedFor(
            `${executionId}-${String(index).padStart(3, "0")}`,
            `record-${executionId}-${index}`,
          ),
        ),
    );
    for (const [executionIndex, executionId] of [
      "bounded-history-a",
      "bounded-history-b",
    ].entries()) {
      const executionProposals = proposals.slice(
        executionIndex * 100,
        executionIndex * 100 + 100,
      );
      await catalogue.createExecution({
        ...executionFor(executionId),
        status: "completed",
        stage: "completed",
        outcome: "partially-succeeded",
        workItems: executionProposals.map(({ proposal }, index) => ({
          key: `format:bounded:${index}`,
          relativePaths: [`${index}.bin`],
          outcome: "proposal" as const,
          proposalId: proposal.id,
          sourceRecordIds: [],
        })),
      });
    }
    catalogue.close();
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      const insert = database.prepare(
        "INSERT INTO recognition_proposals (id, execution_id, basis_json, rule_results_json) VALUES (?, ?, ?, ?)",
      );
      for (const [index, { proposal }] of proposals.entries()) {
        insert.run(
          proposal.id,
          index < 100 ? "bounded-history-a" : "bounded-history-b",
          JSON.stringify(proposal.basis),
          JSON.stringify(proposal.ruleResults),
        );
      }
    } finally {
      database.close();
    }

    const reopened = SqliteCatalogue.forProductData(root);
    await reopened.listWorkflowHistoryPage({ limit: 2 });
    const nativeDatabase = (
      reopened as unknown as { readonly database: DatabaseSync }
    ).database;
    let selectStatements = 0;
    nativeDatabase.setAuthorizer((actionCode) => {
      if (actionCode === sqliteConstants.SQLITE_SELECT) selectStatements += 1;
      return sqliteConstants.SQLITE_OK;
    });
    const page = await reopened.listWorkflowHistoryPage({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items.map(({ proposals: items }) => items.length)).toEqual([
      100, 100,
    ]);
    expect(selectStatements).toBeLessThanOrEqual(8);
    reopened.close();
  });

  it("lists only an explicit current change-impact confirmation as Attention", async () => {
    const catalogue = await createCatalogue();
    const baselineRecord = sourceRecord();
    const baselineAccepted = accepted();
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [baselineRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: baselineAccepted,
    });
    const completeBaseline = await catalogue.freezeChangeImpactBaseline({
      assetId: baselineAccepted.entity.id,
      recognitionSourceAssociationId:
        baselineAccepted.recognitionSourceAssociation.id,
      recognitionDecisionId: baselineAccepted.recognitionDecision.id,
    });
    await catalogue.createExecution({
      ...executionFor("attention-change-impact"),
      status: "completed",
      stage: "completed",
      outcome: "proposal",
    });
    await catalogue.saveChangeImpactPreview({
      ...attentionPreview("attention-change-impact"),
      baselines: [
        {
          key: "source-association",
          value: baselineAccepted.recognitionSourceAssociation.id,
        },
        {
          key: "recognition-decision",
          value: baselineAccepted.recognitionDecision.id,
        },
        {
          key: "source-records",
          value: baselineAccepted.proposal.basis.interpretation.sourceRecordIds
            .toSorted()
            .join(","),
        },
        { key: "complete-current-projection", value: completeBaseline },
      ],
    });
    await catalogue.createExecution({
      ...executionFor("historical-failure"),
      status: "failed",
      stage: "failed",
      outcome: "failed",
    });

    await expect(
      catalogue.listCurrentAttentionPage({ limit: 10 }),
    ).resolves.toMatchObject({
      items: [
        {
          kind: "change-impact-review",
          executionId: "attention-change-impact",
          assetId: "asset",
          changeImpactPreviewId: "attention-preview",
        },
      ],
    });

    await catalogue.rejectChangeImpactPreview({
      previewId: "attention-preview",
      rejectedBy: "attention-reviewer",
    });
    await expect(
      catalogue.listCurrentAttentionPage({ limit: 10 }),
    ).resolves.toEqual({
      items: [],
    });
  });

  it("projects a disabled typed prerequisite as one current Attention and clears it on re-enable", async () => {
    const catalogue = await createCatalogue();
    await catalogue.createAutomationIntentForTesting({
      id: "repairable-prerequisite",
      scope: { observedRootId: "observed-root", relativeScope: "." },
      enabled: true,
      intervalMilliseconds: 60_000,
      workflowInputVersion: "asset-refresh-input/1",
      runInitial: false,
      policyReferences: ["policy/1"],
      acceptTrusted: true,
    });
    await catalogue.createExecution({
      ...executionFor("repairable-prerequisite-execution"),
      automationIntentId: "repairable-prerequisite",
      workflowInput: {
        version: "asset-refresh-input/1",
        trigger: "interval",
        initiatedBy: "automation:repairable-prerequisite",
        acceptTrusted: true,
        configurationReferences: ["policy/1"],
      },
      status: "failed",
      stage: "failed",
      outcome: "failed",
      dispositions: [
        {
          key: "official-source",
          status: "failed",
          failureClassification: { kind: "prerequisite-unavailable" },
        },
      ],
    });
    await catalogue.createExecution({
      ...executionFor("ordinary-terminal-failure"),
      status: "failed",
      stage: "failed",
      outcome: "failed",
      dispositions: [{ key: "ordinary", status: "failed" }],
    });
    await catalogue.setAutomationIntentEnabled(
      "repairable-prerequisite",
      false,
      "prerequisite-unavailable",
    );

    await expect(
      catalogue.inspectExecution("repairable-prerequisite-execution"),
    ).resolves.toMatchObject({
      execution: {
        dispositions: [
          expect.objectContaining({
            failureClassification: { kind: "prerequisite-unavailable" },
          }),
        ],
      },
    });

    await expect(catalogue.listCurrentAttentionPage()).resolves.toMatchObject({
      items: [
        {
          id: "prerequisite-unavailable:repairable-prerequisite",
          kind: "prerequisite-unavailable",
          executionId: "repairable-prerequisite-execution",
        },
      ],
    });

    await catalogue.setAutomationIntentEnabled("repairable-prerequisite", true);
    await expect(catalogue.listCurrentAttentionPage()).resolves.toEqual({
      items: [],
    });
  });

  it("projects a pre-bind unavailable root intent without inventing an execution and clears it on re-enable", async () => {
    const catalogue = await createCatalogue();
    await catalogue.createAutomationIntentForTesting({
      id: "pre-bind-root-unavailable",
      scope: { observedRootId: "missing-root", relativeScope: "." },
      enabled: true,
      intervalMilliseconds: 60_000,
      workflowInputVersion: "asset-refresh-input/1",
      runInitial: false,
      policyReferences: ["policy/1"],
      acceptTrusted: true,
    });
    await catalogue.setAutomationIntentEnabled(
      "pre-bind-root-unavailable",
      false,
      "observed-root-unavailable",
    );
    await expect(catalogue.listAutomationIntents()).resolves.toEqual([
      expect.objectContaining({
        id: "pre-bind-root-unavailable",
        enabled: false,
        disabledReason: "observed-root-unavailable",
      }),
    ]);

    await expect(catalogue.listCurrentAttentionPage()).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "prerequisite-unavailable:pre-bind-root-unavailable",
          kind: "prerequisite-unavailable",
          automationIntentId: "pre-bind-root-unavailable",
        }),
      ],
    });
    await catalogue.setAutomationIntentEnabled(
      "pre-bind-root-unavailable",
      true,
    );
    await expect(catalogue.listCurrentAttentionPage()).resolves.toEqual({
      items: [],
    });
  });

  it("pages each pre-bind unavailable root Attention once with a stable cursor after reopen", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    for (const id of ["prebind-a", "prebind-b"]) {
      await catalogue.createAutomationIntentForTesting({
        id,
        scope: { observedRootId: `${id}-root`, relativeScope: "." },
        enabled: true,
        intervalMilliseconds: 60_000,
        workflowInputVersion: "asset-refresh-input/1",
        runInitial: false,
        policyReferences: ["policy/1"],
        acceptTrusted: true,
      });
      await catalogue.setAutomationIntentEnabled(
        id,
        false,
        "observed-root-unavailable",
      );
    }
    const first = await catalogue.listCurrentAttentionPage({ limit: 1 });
    catalogue.close();
    const reopened = SqliteCatalogue.forProductData(root);
    const second = await reopened.listCurrentAttentionPage({
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(
      [...first.items, ...second.items].map(
        ({ automationIntentId }) => automationIntentId,
      ),
    ).toEqual(["prebind-a", "prebind-b"]);
    expect(second.nextCursor).toBeUndefined();
    reopened.close();
  });

  it("pages one latest prerequisite Attention per intent before applying the limit", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    for (const id of ["attention-a", "attention-b"]) {
      await catalogue.createAutomationIntentForTesting({
        id,
        scope: { observedRootId: `${id}-root`, relativeScope: "." },
        enabled: true,
        intervalMilliseconds: 60_000,
        workflowInputVersion: "asset-refresh-input/1",
        runInitial: false,
        policyReferences: ["policy/1"],
        acceptTrusted: true,
      });
    }
    for (const [id, intent] of [
      ["attention-a-old", "attention-a"],
      ["attention-b-current", "attention-b"],
      ["attention-a-current", "attention-a"],
    ] as const) {
      await catalogue.createExecution({
        ...executionFor(id),
        automationIntentId: intent,
        status: "failed",
        stage: "failed",
        outcome: "failed",
        workflowInput: {
          version: "asset-refresh-input/1",
          trigger: "interval",
          initiatedBy: `automation:${intent}`,
          acceptTrusted: true,
          configurationReferences: ["policy/1"],
        },
        dispositions: [
          {
            key: "source",
            status: "failed",
            failureClassification: { kind: "prerequisite-unavailable" },
          },
        ],
      });
    }
    await catalogue.setAutomationIntentEnabled(
      "attention-a",
      false,
      "prerequisite-unavailable",
    );
    await catalogue.setAutomationIntentEnabled(
      "attention-b",
      false,
      "prerequisite-unavailable",
    );
    const database = (
      catalogue as unknown as { readonly database: DatabaseSync }
    ).database;
    expect(
      database
        .prepare(
          "select id, enabled, disabled_reason from automation_intents order by id",
        )
        .all(),
    ).toEqual([
      {
        id: "attention-a",
        enabled: 0,
        disabled_reason: "prerequisite-unavailable",
      },
      {
        id: "attention-b",
        enabled: 0,
        disabled_reason: "prerequisite-unavailable",
      },
    ]);
    expect(
      database
        .prepare(
          "select automation_intent_id, dispositions_json from workflow_executions order by rowid",
        )
        .all(),
    ).toHaveLength(3);
    const page = await catalogue.listCurrentAttentionPage({ limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual([
      "prerequisite-unavailable:attention-a",
      "prerequisite-unavailable:attention-b",
    ]);
    catalogue.close();
    const reopened = SqliteCatalogue.forProductData(root);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const next = await reopened.listCurrentAttentionPage({
        limit: 1,
        cursor,
      });
      seen.push(...next.items.map((item) => item.id));
      cursor = next.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual([
      "prerequisite-unavailable:attention-a",
      "prerequisite-unavailable:attention-b",
    ]);
    reopened.close();
  });

  it("pages past newer stale previews to every older valid Attention condition", async () => {
    const catalogue = await createCatalogue();
    const baselineRecord = sourceRecord();
    const baselineAccepted = accepted();
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [baselineRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: baselineAccepted,
    });
    const completeBaseline = await catalogue.freezeChangeImpactBaseline({
      assetId: baselineAccepted.entity.id,
      recognitionSourceAssociationId:
        baselineAccepted.recognitionSourceAssociation.id,
      recognitionDecisionId: baselineAccepted.recognitionDecision.id,
    });
    const currentBaselines: ChangeImpactPreview["baselines"] = [
      {
        key: "source-association",
        value: baselineAccepted.recognitionSourceAssociation.id,
      },
      {
        key: "recognition-decision",
        value: baselineAccepted.recognitionDecision.id,
      },
      {
        key: "source-records",
        value: baselineAccepted.proposal.basis.interpretation.sourceRecordIds
          .toSorted()
          .join(","),
      },
      { key: "complete-current-projection", value: completeBaseline },
    ];
    for (const id of ["valid-older", "valid-newer"]) {
      await catalogue.createExecution({
        ...executionFor(`execution-${id}`),
        status: "completed",
        stage: "completed",
        outcome: "proposal",
      });
      await catalogue.saveChangeImpactPreview({
        ...attentionPreview(`execution-${id}`),
        id,
        baselines: currentBaselines,
      });
    }
    for (const id of ["stale-a", "stale-b", "stale-c"]) {
      await catalogue.createExecution({
        ...executionFor(`execution-${id}`),
        status: "completed",
        stage: "completed",
        outcome: "proposal",
      });
      await catalogue.saveChangeImpactPreview({
        ...attentionPreview(`execution-${id}`),
        id,
        baselines: currentBaselines.map((baseline) =>
          baseline.key === "source-association"
            ? { ...baseline, value: "obsolete-association" }
            : baseline,
        ),
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await catalogue.listCurrentAttentionPage({
        limit: 1,
        cursor,
      });
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0].id);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual([
      "change-impact-review:valid-newer",
      "change-impact-review:valid-older",
    ]);
  });

  it("batch-validates one hundred previews without reading unrelated permanent fact history", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const baselineRecord = sourceRecord();
    const baselineAccepted = accepted();
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [baselineRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: baselineAccepted,
    });
    const completeBaseline = await catalogue.freezeChangeImpactBaseline({
      assetId: baselineAccepted.entity.id,
      recognitionSourceAssociationId:
        baselineAccepted.recognitionSourceAssociation.id,
      recognitionDecisionId: baselineAccepted.recognitionDecision.id,
    });
    const baselines: ChangeImpactPreview["baselines"] = [
      {
        key: "source-association",
        value: baselineAccepted.recognitionSourceAssociation.id,
      },
      {
        key: "recognition-decision",
        value: baselineAccepted.recognitionDecision.id,
      },
      {
        key: "source-records",
        value: baselineAccepted.proposal.basis.interpretation.sourceRecordIds
          .toSorted()
          .join(","),
      },
      { key: "complete-current-projection", value: completeBaseline },
    ];
    for (let index = 0; index < 100; index += 1) {
      const id = `bounded-preview-${String(index).padStart(3, "0")}`;
      const executionId = `execution-${id}`;
      await catalogue.createExecution({
        ...executionFor(executionId),
        status: "completed",
        stage: "completed",
        outcome: "proposal",
      });
      await catalogue.saveChangeImpactPreview({
        ...attentionPreview(executionId),
        id,
        baselines,
      });
    }
    catalogue.close();

    const history = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      const insertMetadata = history.prepare(
        "INSERT INTO metadata_assertions (subject_id, target_kind, target_entity_id, property, value, source_record_ids_json) VALUES (?, 'entity', ?, ?, ?, '[]')",
      );
      const insertMetadataLifecycle = history.prepare(
        "INSERT INTO metadata_assertion_lifecycles (assertion_id, source_identity, native_address, coverage_id, source_slot, source_record_id, predecessor_assertion_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const insertRelationship = history.prepare(
        "INSERT INTO entity_relationships (id, type, participants_json, source_record_ids_json) VALUES (?, ?, ?, '[]')",
      );
      const insertRelationshipLifecycle = history.prepare(
        "INSERT INTO relationship_lifecycles (relationship_id, source_subject_id, source_identity, native_address, coverage_id, source_record_id, source_slot, predecessor_relationship_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertArtifact = history.prepare(
        "INSERT INTO artifacts (id) VALUES (?)",
      );
      const insertArtifactAssociation = history.prepare(
        "INSERT INTO artifact_associations (id, target_kind, target_entity_id, subject_id, artifact_id, role, source_record_ids_json) VALUES (?, 'entity', ?, ?, ?, ?, '[]')",
      );
      const insertArtifactSupersession = history.prepare(
        "INSERT INTO artifact_association_supersessions (id, predecessor_association_id, successor_association_id) VALUES (?, ?, ?)",
      );
      history.exec("BEGIN");
      for (let index = 0; index < 250; index += 1) {
        const subjectId = `unrelated-subject-${index}`;
        const predecessorMetadata = Number(
          insertMetadata.run(
            subjectId,
            subjectId,
            "asset.title",
            `old-${index}`,
          ).lastInsertRowid,
        );
        const successorMetadata = Number(
          insertMetadata.run(
            subjectId,
            subjectId,
            "asset.title",
            `new-${index}`,
          ).lastInsertRowid,
        );
        insertMetadataLifecycle.run(
          successorMetadata,
          "unrelated",
          `unrelated:${index}`,
          `coverage-${index}`,
          "title",
          `record-${index}`,
          predecessorMetadata,
        );
        const predecessorRelationship = `unrelated-relationship-old-${index}`;
        const successorRelationship = `unrelated-relationship-new-${index}`;
        insertRelationship.run(
          predecessorRelationship,
          "asset.related",
          JSON.stringify([
            { entityId: subjectId, role: "asset" },
            { entityId: `participant-${index}`, role: "related" },
          ]),
        );
        insertRelationship.run(
          successorRelationship,
          "asset.related",
          JSON.stringify([
            { entityId: subjectId, role: "asset" },
            { entityId: `participant-${index}`, role: "related" },
          ]),
        );
        insertRelationshipLifecycle.run(
          successorRelationship,
          subjectId,
          "unrelated",
          `unrelated:${index}`,
          `coverage-${index}`,
          `record-${index}`,
          "related",
          predecessorRelationship,
        );
        const predecessorArtifact = `unrelated-artifact-old-${index}`;
        const successorArtifact = `unrelated-artifact-new-${index}`;
        const predecessorAssociation = `unrelated-association-old-${index}`;
        const successorAssociation = `unrelated-association-new-${index}`;
        insertArtifact.run(predecessorArtifact);
        insertArtifact.run(successorArtifact);
        insertArtifactAssociation.run(
          predecessorAssociation,
          subjectId,
          subjectId,
          predecessorArtifact,
          "asset.primary-cover",
        );
        insertArtifactAssociation.run(
          successorAssociation,
          subjectId,
          subjectId,
          successorArtifact,
          "asset.primary-cover",
        );
        insertArtifactSupersession.run(
          `unrelated-supersession-${index}`,
          predecessorAssociation,
          successorAssociation,
        );
      }
      history.exec("COMMIT");
    } finally {
      history.close();
    }

    const reopened = SqliteCatalogue.forProductData(root);
    await reopened.listCurrentAttentionPage({ limit: 1 });
    const nativeDatabase = (
      reopened as unknown as { readonly database: DatabaseSync }
    ).database;
    let selectStatements = 0;
    nativeDatabase.setAuthorizer((actionCode) => {
      if (actionCode === sqliteConstants.SQLITE_SELECT) selectStatements += 1;
      return sqliteConstants.SQLITE_OK;
    });
    const countPage = async (limit: number) => {
      selectStatements = 0;
      const page = await reopened.listCurrentAttentionPage({ limit });
      return { page, selectStatements };
    };
    const one = await countPage(1);
    const hundred = await countPage(100);
    expect(one.page.items).toHaveLength(1);
    expect(hundred.page.items).toHaveLength(100);
    expect(hundred.selectStatements).toBeLessThanOrEqual(
      one.selectStatements + 4,
    );
    reopened.close();
  });

  it("pages directly to one valid Attention condition across zero, one hundred, and one thousand persisted stale previews", async () => {
    const catalogue = await createCatalogue();
    const baselineAccepted = accepted();
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [sourceRecord()]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: baselineAccepted,
    });
    await saveCurrentAttentionPreview(catalogue, {
      executionId: "only-valid-preview-owner",
      previewId: "only-valid-preview",
      accepted: baselineAccepted,
    });
    await catalogue.listCurrentAttentionPage({ limit: 1 });
    const nativeDatabase = (
      catalogue as unknown as { readonly database: DatabaseSync }
    ).database;
    let selectStatements = 0;
    nativeDatabase.setAuthorizer((actionCode) => {
      if (actionCode === sqliteConstants.SQLITE_SELECT) selectStatements += 1;
      return sqliteConstants.SQLITE_OK;
    });
    const selectCounts: number[] = [];
    const measure = async () => {
      selectStatements = 0;
      const page = await catalogue.listCurrentAttentionPage({ limit: 1 });
      expect(page.items).toEqual([
        expect.objectContaining({
          kind: "change-impact-review",
          changeImpactPreviewId: "only-valid-preview",
        }),
      ]);
      selectCounts.push(selectStatements);
    };
    await measure();
    const workflowColumns = (
      nativeDatabase
        .prepare("PRAGMA table_xinfo(workflow_executions)")
        .all() as Array<{ readonly name: string; readonly hidden: number }>
    ).filter(({ hidden }) => hidden === 0);
    const quotedWorkflowColumns = workflowColumns
      .map(({ name }) => quoteIdentifier(name))
      .join(", ");
    const cloneExecution = nativeDatabase.prepare(
      `INSERT INTO workflow_executions (${quotedWorkflowColumns})
       SELECT ${workflowColumns
         .map(({ name }) => (name === "id" ? "?" : quoteIdentifier(name)))
         .join(", ")}
       FROM workflow_executions WHERE id = ?`,
    );
    const insertPreview = nativeDatabase.prepare(
      "INSERT INTO change_impact_previews (id, execution_id, asset_id, preview_json) VALUES (?, ?, ?, ?)",
    );
    const insertPersistedStale = (start: number, end: number) => {
      nativeDatabase.exec("BEGIN");
      for (let index = start; index < end; index += 1) {
        const suffix = String(index).padStart(4, "0");
        const executionId = `persisted-stale-owner-${suffix}`;
        cloneExecution.run(executionId, "only-valid-preview-owner");
        insertPreview.run(
          `persisted-stale-preview-${suffix}`,
          executionId,
          baselineAccepted.entity.id,
          JSON.stringify({
            ...attentionPreview(executionId),
            id: `persisted-stale-preview-${suffix}`,
            status: "stale",
          }),
        );
      }
      nativeDatabase.exec("COMMIT");
    };
    insertPersistedStale(0, 100);
    await measure();
    insertPersistedStale(100, 1_000);
    await measure();
    expect(selectCounts).toHaveLength(3);
    expect(new Set(selectCounts).size).toBe(1);
    expect(
      nativeDatabase
        .prepare(
          "SELECT id, status FROM change_impact_previews WHERE id IN (?, ?) ORDER BY id",
        )
        .all("only-valid-preview", "persisted-stale-preview-0000"),
    ).toEqual([
      { id: "only-valid-preview", status: "awaiting-confirmation" },
      { id: "persisted-stale-preview-0000", status: "stale" },
    ]);
    const previewAccess = (
      nativeDatabase
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT change_impact_previews.id
           FROM change_impact_previews
           INNER JOIN workflow_executions
             ON workflow_executions.id = change_impact_previews.execution_id
           WHERE change_impact_previews.status = 'awaiting-confirmation'
           ORDER BY workflow_executions.rowid DESC, change_impact_previews.id ASC
           LIMIT 2`,
        )
        .all() as Array<{ readonly detail: string }>
    )
      .map(({ detail }) =>
        /^(SCAN|SEARCH) (\S+)(?: USING (?:COVERING )?INDEX (\S+))?/u.exec(
          detail,
        ),
      )
      .flatMap((match) =>
        match === null
          ? []
          : [{ operation: match[1], table: match[2], index: match[3] }],
      )
      .filter(({ table }) => table === "change_impact_previews");
    expect(previewAccess).toEqual([
      {
        operation: "SEARCH",
        table: "change_impact_previews",
        index: "change_impact_previews_status",
      },
    ]);
    await expect(
      catalogue.rejectChangeImpactPreview({
        previewId: "only-valid-preview",
        rejectedBy: "attention-reviewer",
      }),
    ).resolves.toBe("rejected");
    expect(
      nativeDatabase
        .prepare("SELECT status FROM change_impact_previews WHERE id = ?")
        .get("only-valid-preview"),
    ).toEqual({ status: "rejected" });
  });

  it("fails closed for direct SQLite page limits and foreign or malformed cursors", async () => {
    const catalogue = await createCatalogue();
    const encodeCursor = (payload: object) =>
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const queries: readonly {
      readonly list: (input: {
        readonly limit?: number;
        readonly cursor?: string;
      }) => Promise<unknown>;
    }[] = [
      { list: (input) => catalogue.listCurrentCataloguePage(input) },
      { list: (input) => catalogue.listWorkflowHistoryPage(input) },
      { list: (input) => catalogue.listCurrentAttentionPage(input) },
    ];

    await expect(catalogue.listCurrentCataloguePage()).resolves.toEqual({
      items: [],
    });
    await expect(catalogue.listWorkflowHistoryPage()).resolves.toEqual({
      items: [],
    });
    await expect(catalogue.listCurrentAttentionPage()).resolves.toEqual({
      items: [],
    });

    for (const { list } of queries) {
      for (const limit of [0, 101, 1.5]) {
        await expect(list({ limit })).rejects.toThrow();
      }
      for (const cursor of ["not-a-cursor", "e30"]) {
        await expect(list({ limit: 1, cursor })).rejects.toThrow();
      }
    }

    const catalogueCursor = encodeCursor({
      version: 1,
      query: "current-catalogue",
      anchor: "asset",
    });
    const historyCursor = encodeCursor({
      version: 1,
      query: "workflow-history",
      sequence: 1,
      id: "execution",
    });
    const attentionCursor = encodeCursor({
      version: 2,
      query: "current-attention",
      sequence: 1,
      kind: 0,
      id: "proposal",
    });
    const oversizedCatalogueCursor = encodeCursor({
      version: 1,
      query: "current-catalogue",
      anchor: "a".repeat(5000),
    });
    const oversizedHistoryCursor = encodeCursor({
      version: 1,
      query: "workflow-history",
      sequence: 1,
      id: "a".repeat(5000),
    });
    const oversizedAttentionCursor = encodeCursor({
      version: 2,
      query: "current-attention",
      sequence: 1,
      kind: 0,
      id: "a".repeat(5000),
    });
    await expect(
      catalogue.listCurrentCataloguePage({ limit: 1, cursor: historyCursor }),
    ).rejects.toThrow();
    await expect(
      catalogue.listWorkflowHistoryPage({ limit: 1, cursor: attentionCursor }),
    ).rejects.toThrow();
    await expect(
      catalogue.listCurrentAttentionPage({ limit: 1, cursor: catalogueCursor }),
    ).rejects.toThrow();
    await expect(
      catalogue.listCurrentCataloguePage({
        limit: 1,
        cursor: oversizedCatalogueCursor,
      }),
    ).rejects.toThrow();
    await expect(
      catalogue.listWorkflowHistoryPage({
        limit: 1,
        cursor: oversizedHistoryCursor,
      }),
    ).rejects.toThrow();
    await expect(
      catalogue.listCurrentAttentionPage({
        limit: 1,
        cursor: oversizedAttentionCursor,
      }),
    ).rejects.toThrow();

    await expect(
      catalogue.listCurrentCataloguePage({
        limit: 1,
        cursor: encodeCursor({
          version: 99,
          query: "current-catalogue",
          anchor: "asset",
        }),
      }),
    ).rejects.toThrow();
    await expect(
      catalogue.listWorkflowHistoryPage({
        limit: 1,
        cursor: encodeCursor({
          version: 99,
          query: "workflow-history",
          sequence: 1,
          id: "execution",
        }),
      }),
    ).rejects.toThrow();
    await expect(
      catalogue.listCurrentAttentionPage({
        limit: 1,
        cursor: encodeCursor({
          version: 99,
          query: "current-attention",
          sequence: 1,
          kind: 0,
          id: "proposal",
        }),
      }),
    ).rejects.toThrow();

    for (const sequence of [0, -1]) {
      await expect(
        catalogue.listWorkflowHistoryPage({
          limit: 1,
          cursor: encodeCursor({
            version: 1,
            query: "workflow-history",
            sequence,
            id: "execution",
          }),
        }),
      ).rejects.toThrow();
      await expect(
        catalogue.listCurrentAttentionPage({
          limit: 1,
          cursor: encodeCursor({
            version: 2,
            query: "current-attention",
            sequence,
            kind: 0,
            id: "proposal",
          }),
        }),
      ).rejects.toThrow();
    }
  });

  it("rebuilds an initial Recognition review until its durable decision exists", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const record = sourceRecordFor("recognition-review");
    const proposed = acceptedFor("recognition-review", record.id);
    await catalogue.createExecution(executionFor("recognition-review"));
    await retainSourceRecords(catalogue, "recognition-review", [record]);
    const baseline = (await catalogue.inspectExecution("recognition-review"))!
      .execution;
    await catalogue.finishExecutionWithProposal(
      baseline,
      {
        ...baseline,
        status: "completed",
        stage: "completed",
        outcome: "proposal",
        proposalId: proposed.proposal.id,
      },
      proposed.proposal,
    );

    await expect(
      catalogue.listCurrentAttentionPage({ limit: 10 }),
    ).resolves.toMatchObject({
      items: [
        {
          kind: "recognition-review",
          executionId: "recognition-review",
          recognitionProposalId: proposed.proposal.id,
        },
      ],
    });

    // 当前条件是缺少接受决定。夹具直接写入该权威下游事实，因为 V1 尚无用于后续
    // 手动接受提案的独立命令。
    catalogue.close();
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      database
        .prepare(
          "INSERT INTO recognition_decisions (id, proposal_id, asset_id, accepted_rule_results_json) VALUES (?, ?, ?, ?)",
        )
        .run(
          "recognition-review-decision",
          proposed.proposal.id,
          "accepted-recognition-review",
          JSON.stringify(proposed.proposal.ruleResults),
        );
    } finally {
      database.close();
    }
    const reopened = SqliteCatalogue.forProductData(root);
    await expect(
      reopened.listCurrentAttentionPage({ limit: 10 }),
    ).resolves.toEqual({
      items: [],
    });
    reopened.close();
  });

  it("pages mixed-case and Unicode Attention IDs across all three kinds without gaps", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const proposals = [
      acceptedFor("B-multi-recognition", "multi-record-B").proposal,
      acceptedFor("a-multi-recognition", "multi-record-a").proposal,
      acceptedFor("é-multi-recognition", "multi-record-unicode").proposal,
    ];
    await catalogue.createExecution({
      ...executionFor("multi-recognition-review"),
      status: "completed",
      stage: "completed",
      outcome: "partially-succeeded",
      workItems: proposals.map((proposal, index) => ({
        key: `format:multi-recognition:${index}`,
        relativePaths: [`work-${index}.bin`],
        outcome: "proposal" as const,
        proposalId: proposal.id,
        sourceRecordIds: [],
      })),
    });
    const attentionRecord = sourceRecordFor("attention-asset");
    const attentionAccepted = acceptedFor(
      "attention-asset",
      attentionRecord.id,
    );
    await catalogue.createExecution(executionFor("attention-baseline"));
    await retainSourceRecords(catalogue, "attention-baseline", [
      attentionRecord,
    ]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecutionFor("attention-baseline", "attention-asset"),
      accepted: attentionAccepted,
    });
    const attentionCompleteBaseline =
      await catalogue.freezeChangeImpactBaseline({
        assetId: attentionAccepted.entity.id,
        recognitionSourceAssociationId:
          attentionAccepted.recognitionSourceAssociation.id,
        recognitionDecisionId: attentionAccepted.recognitionDecision.id,
      });
    const validPreview = {
      ...attentionPreview("multi-recognition-review"),
      assetId: "attention-asset",
      baselines: [
        {
          key: "source-association",
          value: attentionAccepted.recognitionSourceAssociation.id,
        },
        {
          key: "recognition-decision",
          value: attentionAccepted.recognitionDecision.id,
        },
        {
          key: "source-records",
          value: attentionAccepted.proposal.basis.interpretation.sourceRecordIds
            .toSorted()
            .join(","),
        },
        {
          key: "complete-current-projection",
          value: attentionCompleteBaseline,
        },
      ],
    } satisfies ChangeImpactPreview;
    catalogue.close();

    // 提案是不可变领域结果；上方执行审计则是声明两个工作项目仍等待审核的权威。
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      const insert = database.prepare(
        "INSERT INTO recognition_proposals (id, execution_id, basis_json, rule_results_json) VALUES (?, ?, ?, ?)",
      );
      for (const proposal of proposals) {
        insert.run(
          proposal.id,
          "multi-recognition-review",
          JSON.stringify(proposal.basis),
          JSON.stringify(proposal.ruleResults),
        );
      }
      const insertPreview = database.prepare(
        "INSERT INTO change_impact_previews (id, execution_id, asset_id, preview_json) VALUES (?, ?, ?, ?)",
      );
      for (const id of ["B-preview", "a-preview", "é-preview"]) {
        insertPreview.run(
          id,
          "multi-recognition-review",
          "attention-asset",
          JSON.stringify({
            ...validPreview,
            id,
            proposal: { ...validPreview.proposal, id: `unrelated-${id}` },
          }),
        );
      }
      database
        .prepare(
          "INSERT INTO source_refresh_runs (id, workflow_execution_id, initiated_by, initiated_at, requested_selection_json, review_policy) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "attention-run",
          "multi-recognition-review",
          "test",
          "2026-01-01T00:00:00.000Z",
          JSON.stringify({ subjectId: "attention-asset" }),
          "review",
        );
      const insertChangeSet = database.prepare(
        "INSERT INTO source_refresh_change_sets (id, run_id, source_identity, native_address, coverage_id, candidate_source_record_id, changes_json, interpretation_json, requires_review, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending')",
      );
      const insertScope = database.prepare(
        "INSERT INTO source_refresh_scopes (run_id, ordinal, source_identity, native_address, coverage_id, state, change_set_id) VALUES (?, ?, ?, ?, ?, 'awaiting-review', ?)",
      );
      for (const [ordinal, id] of [
        "B-change-set",
        "a-change-set",
        "é-change-set",
      ].entries()) {
        const sourceIdentity = `source-${ordinal}`;
        const nativeAddress = `https://source.example/${ordinal}`;
        const coverageId = `coverage-${ordinal}`;
        insertChangeSet.run(
          id,
          "attention-run",
          sourceIdentity,
          nativeAddress,
          coverageId,
          `record-${ordinal}`,
          "[]",
          "{}",
        );
        insertScope.run(
          "attention-run",
          ordinal,
          sourceIdentity,
          nativeAddress,
          coverageId,
          id,
        );
      }
    } finally {
      database.close();
    }

    const reopened = SqliteCatalogue.forProductData(root);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reopened.listCurrentAttentionPage({
        limit: 1,
        cursor,
      });
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0].id);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual([
      ...proposals.map(({ id }) => `recognition-review:${id}`),
      ...["B-preview", "a-preview", "é-preview"].map(
        (id) => `change-impact-review:${id}`,
      ),
      ...["B-change-set", "a-change-set", "é-change-set"].map(
        (id) => `source-refresh-review:${id}`,
      ),
    ]);
    reopened.close();
  });

  it("retains a primary accepted source head when no source is currently applicable", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [sourceRecord()]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });
    catalogue.close();

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      for (const [id, address] of [
        ["secondary-z", "https://source.example/z"],
        ["secondary-a", "https://source.example/a"],
      ] as const) {
        insertCurrentSourceAssociation(database, {
          id,
          subjectId: "asset",
          sourceIdentity: "source",
          nativeAddress: address,
        });
      }
    } finally {
      database.close();
    }

    await expect(catalogue.listCurrentCatalogue()).resolves.toMatchObject([
      {
        recognitionSourceAssociation: { id: "association" },
        sourceAssociations: [
          { id: "association" },
          { id: "secondary-z" },
          { id: "secondary-a" },
        ],
      },
    ]);
    // 多个当前适用的来源关联会丰富同一主体；它们绝不能变成重复的当前目录行。
    await expect(
      catalogue.listCurrentCataloguePage({ limit: 1 }),
    ).resolves.toMatchObject({
      items: [
        {
          entity: { id: "asset" },
          sourceAssociations: [
            { id: "association" },
            { id: "secondary-z" },
            { id: "secondary-a" },
          ],
        },
      ],
    });
    const missingCurrent = new DatabaseSync(
      path.join(root, "catalogue.sqlite"),
    );
    try {
      missingCurrent
        .prepare(
          "DELETE FROM current_source_associations WHERE subject_id = ? AND association_id = ?",
        )
        .run("asset", "association");
    } finally {
      missingCurrent.close();
    }
    const afterPrimaryStoppedApplying = await catalogue.listCurrentCatalogue();
    expect(afterPrimaryStoppedApplying).toHaveLength(1);
    expect(afterPrimaryStoppedApplying[0]?.recognitionSourceAssociation).toBe(
      undefined,
    );
    expect(
      afterPrimaryStoppedApplying[0]?.sourceAssociations.map(
        (association) => association.id,
      ),
    ).toEqual(expect.arrayContaining(["secondary-a", "secondary-z"]));

    const noCurrentSources = new DatabaseSync(
      path.join(root, "catalogue.sqlite"),
    );
    try {
      noCurrentSources
        .prepare("DELETE FROM current_source_associations WHERE subject_id = ?")
        .run("asset");
    } finally {
      noCurrentSources.close();
    }
    const withoutCurrentSources = await catalogue.listCurrentCatalogue();
    expect(withoutCurrentSources).toHaveLength(1);
    expect(withoutCurrentSources[0]).toMatchObject({
      sourceAssociations: [],
    });
    expect(withoutCurrentSources[0]?.recognitionSourceAssociation).toBe(
      undefined,
    );
    const durableRecognitionHead = new DatabaseSync(
      path.join(root, "catalogue.sqlite"),
    );
    try {
      expect(
        durableRecognitionHead
          .prepare(
            `SELECT recognition_source_association_id, recognition_decision_id
             FROM recognition_heads WHERE subject_id = ?`,
          )
          .get("asset"),
      ).toEqual({
        recognition_source_association_id: "association",
        recognition_decision_id: "decision",
      });
    } finally {
      durableRecognitionHead.close();
    }
    catalogue.close();
  });

  it("keeps the public Current Catalogue projection equivalent to retained acceptance ordering", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [sourceRecord()]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });
    catalogue.close();

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      for (const [id, address] of [
        ["secondary-z", "https://source.example/z"],
        ["secondary-a", "https://source.example/a"],
      ] as const) {
        insertCurrentSourceAssociation(database, {
          id,
          subjectId: "asset",
          sourceIdentity: "source",
          nativeAddress: address,
        });
      }
      for (const id of ["z-artifact", "a-artifact"] as const) {
        database.prepare("INSERT INTO artifacts (id) VALUES (?)").run(id);
      }
      for (const [id, artifactId] of [
        ["z-artifact-association", "z-artifact"],
        ["a-artifact-association", "a-artifact"],
      ] as const) {
        database
          .prepare(
            `INSERT INTO artifact_associations (
              id, target_kind, target_entity_id, subject_id, artifact_id, role, source_record_ids_json
            ) VALUES (?, 'entity', ?, ?, ?, ?, '[]')`,
          )
          .run(id, "asset", "asset", artifactId, "asset.gallery");
      }
      database
        .prepare(
          `INSERT INTO artifact_association_retractions (
            id, association_id, recognition_decision_id, proposal_id,
            source_record_ids_json
          ) VALUES (?, ?, NULL, ?, '[]')`,
        )
        .run("retract-z-artifact", "z-artifact-association", "proposal");
    } finally {
      database.close();
    }

    const inspection = await catalogue.inspectExecution("execution");
    expect(inspection.accepted).toBeDefined();
    const current = await catalogue.listCurrentCatalogue();
    expect(current).toEqual([inspection.accepted]);
    const page = await catalogue.listCurrentCataloguePage({ limit: 10 });
    expect(page.items).toEqual(current);
    expect(page.items[0]).toEqual(inspection.accepted);
    expect(
      current[0]?.sourceAssociations.map((association) => association.id),
    ).toEqual(["association", "secondary-z", "secondary-a"]);
    expect(
      current[0]?.artifactAssociations.map((association) => association.id),
    ).toEqual(["a-artifact-association", "artifact-association"]);
    expect(current[0]).not.toHaveProperty("metadataPolicyIds");
    catalogue.close();
  });

  it("prepares the reviewed schema only in an explicit disposable root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-"));
    cleanup.push(root);

    const prepared = await prepareDisposableCatalogue({ root });
    expect(prepared.databasePath).toBe(path.join(root, "catalogue.sqlite"));

    const database = new DatabaseSync(prepared.databasePath);
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'recognition_heads'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(isPreparedCatalogue(prepared.databasePath)).toBe(true);
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(
        database
          .prepare(
            "SELECT name, type, hidden FROM pragma_table_xinfo('change_impact_previews') WHERE name = 'status'",
          )
          .get(),
      ).toEqual({ name: "status", type: "TEXT", hidden: 2 });
      expect(
        database
          .prepare(
            "SELECT name FROM pragma_index_list('change_impact_previews') WHERE name = 'change_impact_previews_status'",
          )
          .get(),
      ).toEqual({ name: "change_impact_previews_status" });
    } finally {
      database.close();
    }
  });

  it("refuses to prepare a disposable schema in the product-data root", async () => {
    const productDataDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-product-data-"),
    );
    cleanup.push(productDataDirectory);

    await expect(
      prepareDisposableCatalogue({
        root: productDataDirectory,
        productDataDirectory,
      }),
    ).rejects.toThrow("must not overlap product data");
  });

  it("prepares an explicitly named disposable test product-data directory", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-product-data-root-"),
    );
    const productDataDirectory = path.join(root, "product-data");
    const previousProductData = process.env.DIGITAL_PRODUCT_DATA;
    cleanup.push(root);
    process.env.DIGITAL_PRODUCT_DATA = path.join(
      tmpdir(),
      `digital-real-product-data-${randomUUID()}`,
    );
    try {
      const prepared = await prepareDisposableProductDataCatalogue({
        productDataDirectory,
      });
      expect(prepared.databasePath).toBe(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      expect(isPreparedCatalogue(prepared.databasePath)).toBe(true);
    } finally {
      if (previousProductData === undefined)
        delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previousProductData;
    }
  });

  it("refuses a test product-data path that escapes through a disposable symlink", async () => {
    const escapedRoot = await mkdtemp(
      path.join(tmpdir(), "digital-product-data-"),
    );
    const symlinkRoot = path.join(
      tmpdir(),
      `digital-disposable-product-data-symlink-${randomUUID()}`,
    );
    cleanup.push(escapedRoot, symlinkRoot);
    await symlink(escapedRoot, symlinkRoot, "dir");

    await expect(
      prepareDisposableProductDataCatalogue({
        productDataDirectory: path.join(symlinkRoot, "product-data"),
      }),
    ).rejects.toThrow("escapes the system temporary directory");
    await expect(
      access(path.join(escapedRoot, "product-data", "catalogue.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a direct Drizzle disposable push through a product-data symlink", async () => {
    const productDataDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-product-data-"),
    );
    const symlinkRoot = path.join(
      tmpdir(),
      `digital-disposable-symlink-${randomUUID()}`,
    );
    cleanup.push(productDataDirectory, symlinkRoot);
    await symlink(productDataDirectory, symlinkRoot, "dir");

    const result = await execFileAsync(
      "pnpm",
      ["--filter", "@digital/sqlite", "db:push:disposable"],
      {
        cwd: path.resolve(import.meta.dirname, "../../.."),
        env: {
          ...process.env,
          DIGITAL_DISPOSABLE_CATALOGUE_ROOT: symlinkRoot,
          DIGITAL_PRODUCT_DATA: productDataDirectory,
        },
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(result).toBeDefined();
    expect(result).toMatchObject({ code: expect.any(Number) });
    await expect(
      access(path.join(productDataDirectory, "catalogue.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an explicitly Drizzle-prepared schema without a production migration ledger", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-"));
    cleanup.push(root);
    await prepareDisposableCatalogue({ root });

    const catalogue = SqliteCatalogue.forProductData(root);
    await expect(catalogue.listExecutions()).rejects.toThrow(
      "Catalogue 缺少生产迁移账本",
    );
    catalogue.close();
  });

  it("checks an absent catalogue path without creating a database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-"));
    cleanup.push(root);
    const databasePath = path.join(root, "absent-catalogue.sqlite");

    await expect(access(databasePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(isPreparedCatalogue(databasePath)).toBe(false);
    await expect(access(databasePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not hide an unexpected damaged catalogue read failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-"));
    cleanup.push(root);
    const databasePath = path.join(root, "damaged-catalogue.sqlite");
    await writeFile(databasePath, "not a SQLite catalogue", "utf8");

    expect(() => isPreparedCatalogue(databasePath)).toThrow(
      /file is not a database/u,
    );
  });

  it.each([
    {
      name: "a missing versioned audit column",
      damage: (database: DatabaseSync) => {
        database.exec("ALTER TABLE workflow_executions DROP COLUMN audit_json");
      },
    },
    {
      name: "a changed workflow audit default",
      damage: (database: DatabaseSync) => {
        const table = database
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_executions'",
          )
          .get() as { readonly sql: string };
        const indexes = database
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workflow_executions' AND sql IS NOT NULL ORDER BY name",
          )
          .all() as readonly { readonly sql: string }[];
        const damagedSql = table.sql.replace(
          "DEFAULT 'scan-now'",
          "DEFAULT 'unexpected-intent'",
        );
        expect(damagedSql).not.toBe(table.sql);
        database.exec("DROP TABLE workflow_executions");
        database.exec(damagedSql);
        for (const index of indexes) database.exec(index.sql);
      },
    },
    {
      name: "a missing reviewed index",
      damage: (database: DatabaseSync) => {
        database.exec("DROP INDEX workflow_executions_accepted_asset");
      },
    },
    {
      name: "a generated Attention status with a constant expression",
      damage: (database: DatabaseSync) => {
        rewriteChangeImpactPreviewsSchema(database, (sql) =>
          sql.replace(
            "json_extract(preview_json, '$.status')",
            "'awaiting-confirmation'",
          ),
        );
      },
    },
    {
      name: "a generated Attention status with the wrong JSON path",
      damage: (database: DatabaseSync) => {
        rewriteChangeImpactPreviewsSchema(database, (sql) =>
          sql.replace("'$.status'", "'$.proposal.id'"),
        );
      },
    },
    {
      name: "a stored generated Attention status",
      damage: (database: DatabaseSync) => {
        rewriteChangeImpactPreviewsSchema(database, (sql) =>
          sql.replace(" VIRTUAL", " STORED"),
        );
      },
    },
    {
      name: "an ordinary non-generated Attention status column",
      damage: (database: DatabaseSync) => {
        rewriteChangeImpactPreviewsSchema(database, (sql) =>
          sql.replace(
            " GENERATED ALWAYS AS (json_extract(preview_json, '$.status')) VIRTUAL",
            "",
          ),
        );
      },
    },
    {
      name: "a missing reviewed unique index",
      damage: (database: DatabaseSync) => {
        database.exec("DROP INDEX recognition_decisions_proposal");
      },
    },
    {
      name: "a missing primary key",
      damage: (database: DatabaseSync) => {
        database.exec("DROP TABLE recognition_heads");
        database.exec(`CREATE TABLE recognition_heads (
          subject_id TEXT NOT NULL,
          recognition_source_association_id TEXT,
          recognition_decision_id TEXT NOT NULL
        )`);
      },
    },
  ])(
    "fails closed for a damaged reviewed schema with $name",
    async ({ damage }) => {
      const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-"));
      cleanup.push(root);
      const prepared = await prepareDisposableCatalogue({ root });
      const damaged = new DatabaseSync(prepared.databasePath);
      try {
        damage(damaged);
      } finally {
        damaged.close();
      }
      expect(isPreparedCatalogue(prepared.databasePath)).toBe(false);

      const catalogue = SqliteCatalogue.forProductData(root);
      await expect(catalogue.listExecutions()).rejects.toThrow();
      catalogue.close();
    },
  );

  it("extracts nested CHECK expressions while ignoring quoted and commented lookalikes", () => {
    const database = new DatabaseSync(":memory:");
    const equivalent = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE scanner_probe (
        "CHECK (quoted identifier)" TEXT DEFAULT 'CHECK (string literal)',
        value INTEGER,
        /* CHECK (block-comment lookalike) */
        -- CHECK (line-comment lookalike)
        CHECK /* allowed trivia */ (
          coalesce(value, instr(')', '(' /* unmatched: ) */)) > 0
        )
      )`);

      const expected = [
        [
          "scanner_probe|word:coalesce",
          "symbol:(",
          "word:value",
          "symbol:,",
          "word:instr",
          "symbol:(",
          'string:")"',
          "symbol:,",
          'string:"("',
          "symbol:)",
          "symbol:)",
          "symbol:>",
          "number:0",
        ].join("\u001f"),
      ];
      expect(inspectSqliteSchema(database).checks).toEqual(expected);

      equivalent.exec(`CREATE TABLE scanner_probe (
        "CHECK (quoted identifier)" TEXT DEFAULT 'CHECK (string literal)',
        value INTEGER,
        CHECK -- keyword trivia
        (
          COALESCE /* formatting only */ (
            value,
            INSTR (')', '(')
          ) > 0
        )
      )`);
      expect(inspectSqliteSchema(equivalent).checks).toEqual(expected);
    } finally {
      database.close();
      equivalent.close();
    }
  });

  it("fails readiness for a column-level CHECK", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-"));
    cleanup.push(root);
    const prepared = await prepareDisposableCatalogue({ root });
    const database = new DatabaseSync(prepared.databasePath);
    try {
      rewriteChangeImpactPreviewsSchema(database, (sql) =>
        sql.replace(
          /([`"]preview_json[`"]\s+text\s+NOT NULL)/iu,
          "$1 CHECK /* column constraint */ (length(preview_json) > 0)",
        ),
      );
    } finally {
      database.close();
    }

    expect(isPreparedCatalogue(prepared.databasePath)).toBe(false);
  });

  it("accepts equivalent generated SQL formatting and identifier quoting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-"));
    cleanup.push(root);
    const prepared = await prepareDisposableCatalogue({ root });
    const database = new DatabaseSync(prepared.databasePath);
    try {
      rewriteChangeImpactPreviewsSchema(database, (sql) =>
        sql.replace(
          "json_extract(preview_json, '$.status')",
          `JSON_EXTRACT (
            "preview_json",
            '$.status'
          )`,
        ),
      );
    } finally {
      database.close();
    }
    expect(isPreparedCatalogue(prepared.databasePath)).toBe(true);
    await prepareWithFormalMigration(root);
    const catalogue = SqliteCatalogue.forProductData(root);
    await expect(catalogue.listCurrentAttentionPage()).resolves.toEqual({
      items: [],
    });
    catalogue.close();
  });

  it.each([
    ["block comment", "CHECK /* injected trivia */"],
    ["line comment", "CHECK -- injected trivia\n"],
  ])(
    "fails readiness for a table CHECK separated by a $name",
    async (_name, checkKeyword) => {
      const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-"));
      cleanup.push(root);
      const prepared = await prepareDisposableCatalogue({ root });
      const database = new DatabaseSync(prepared.databasePath);
      try {
        rewriteChangeImpactPreviewsSchema(database, (sql) =>
          sql.replace(
            /\)\s*$/u,
            `, ${checkKeyword} (status <> 'awaiting-confirmation'))`,
          ),
        );
        expect(() =>
          database
            .prepare(
              "INSERT INTO change_impact_previews (id, execution_id, asset_id, preview_json) VALUES (?, ?, ?, ?)",
            )
            .run(
              "blocked-preview",
              "execution",
              "asset",
              JSON.stringify({ status: "awaiting-confirmation" }),
            ),
        ).toThrow(/CHECK constraint failed/u);
      } finally {
        database.close();
      }

      expect(isPreparedCatalogue(prepared.databasePath)).toBe(false);
    },
  );

  it("distinguishes a production-migrated catalogue from a raw reviewed schema", async () => {
    const { root: preparedRoot, catalogue } = await createCatalogueWithRoot();
    catalogue.close();
    const disposableRoot = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-"),
    );
    cleanup.push(disposableRoot);
    const prepared = await prepareDisposableCatalogue({ root: disposableRoot });

    expect(
      isPreparedCatalogue(path.join(preparedRoot, "catalogue.sqlite")),
    ).toBe(false);
    expect(isPreparedCatalogue(prepared.databasePath)).toBe(true);
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: preparedRoot,
      }),
    ).resolves.toMatchObject({ state: "ready" });
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: disposableRoot,
      }),
    ).resolves.toMatchObject({ state: "catalogue-not-prepared" });
  });

  it("keeps every pushed TEXT primary key physically NOT NULL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-"));
    cleanup.push(root);
    const prepared = await prepareDisposableCatalogue({ root });
    const database = new DatabaseSync(prepared.databasePath);
    try {
      const textPrimaryKeys = database
        .prepare(
          `SELECT m.name AS table_name, p.name AS column_name,
                    p."notnull" AS not_null
             FROM sqlite_master m
             JOIN pragma_table_info(m.name) p
             WHERE m.type = 'table'
               AND m.name NOT LIKE 'sqlite_%'
               AND upper(p.type) = 'TEXT'
               AND p.pk > 0
             ORDER BY m.name, p.pk`,
        )
        .all() as readonly {
        readonly table_name: string;
        readonly column_name: string;
        readonly not_null: number;
      }[];
      expect(textPrimaryKeys).not.toEqual([]);
      for (const key of textPrimaryKeys) {
        expect(key.not_null).toBe(1);
        expect(() =>
          database
            .prepare(
              `INSERT INTO ${quoteIdentifier(key.table_name)} (${quoteIdentifier(
                key.column_name,
              )}) VALUES (NULL)`,
            )
            .run(),
        ).toThrow();
      }
    } finally {
      database.close();
    }
  });

  it("enforces reviewed catalogue uniqueness and lineage in the pushed schema", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-"));
    cleanup.push(root);
    const prepared = await prepareDisposableCatalogue({ root });
    const database = new DatabaseSync(prepared.databasePath);
    try {
      database.prepare("INSERT INTO entities (id) VALUES (?)").run("asset");
      database
        .prepare(
          "INSERT INTO entity_kind_assertions (id, entity_id, kind, basis, source_record_ids_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run("asset-kind", "asset", "digital-asset", "source", "[]");
      database
        .prepare(
          "INSERT INTO recognition_proposals (id, execution_id, basis_json, rule_results_json) VALUES (?, ?, ?, ?)",
        )
        .run("proposal", "execution", '{"kind":"observed-evidence"}', "[]");
      database
        .prepare(
          "INSERT INTO source_associations (id, subject_id, source_identity, native_address) VALUES (?, ?, ?, ?)",
        )
        .run("association", "asset", "source", "https://source.example/work");
      database
        .prepare(
          "INSERT INTO recognition_decisions (id, proposal_id, asset_id, accepted_rule_results_json) VALUES (?, ?, ?, ?)",
        )
        .run("decision", "proposal", "asset", "[]");
      database
        .prepare(
          `INSERT INTO source_association_establishment_supports (
            association_id, recognition_decision_id, source_association_decision_id
          ) VALUES (?, ?, NULL)`,
        )
        .run("association", "decision");
      database
        .prepare(
          "INSERT INTO recognition_heads (subject_id, recognition_source_association_id, recognition_decision_id) VALUES (?, ?, ?)",
        )
        .run("asset", "association", "decision");
      expect(() =>
        database
          .prepare(
            "INSERT INTO recognition_heads (subject_id, recognition_source_association_id, recognition_decision_id) VALUES (?, ?, ?)",
          )
          .run("asset", "other-association", "other-decision"),
      ).toThrow();

      database
        .prepare(
          "INSERT INTO source_lineage_heads (subject_id, source_identity, native_address, coverage_id, source_record_id) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          "asset",
          "source",
          "https://source.example/work",
          "complete",
          "one",
        );
      expect(() =>
        database
          .prepare(
            "INSERT INTO source_lineage_heads (subject_id, source_identity, native_address, coverage_id, source_record_id) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            "asset",
            "source",
            "https://source.example/work",
            "complete",
            "two",
          ),
      ).toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO recognition_decisions (id, proposal_id, asset_id, accepted_rule_results_json) VALUES (?, ?, ?, ?)",
          )
          .run("decision-two", "proposal", "asset", "[]"),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("projects fulfillment facts only from the selected subject and managed locations", async () => {
    const catalogue = await createCatalogue();
    const sourceRecord = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "fulfillment-facts-record",
      body: "{}",
    };
    const base = accepted();
    const related = {
      id: "related-subject",
      kind: "entity" as const,
      sourceIdentity: "source",
      sourceKey: "related",
      identityNamespace: "source.related",
      label: "Related subject",
      sourceRecordIds: [sourceRecord.id],
    };
    const fact: AcceptedRecognition = {
      ...base,
      proposal: {
        ...base.proposal,
        basis: {
          kind: "source-interpretation",
          interpretation: {
            ...base.proposal.basis.interpretation,
            entities: [
              ...(base.proposal.basis.interpretation.entities ?? []),
              related,
            ],
            metadata: [
              ...base.proposal.basis.interpretation.metadata,
              {
                subjectId: related.id,
                property: "asset.related-only-title",
                sourceSlot: "source.related.title",
                value: "Only related",
                sourceRecordIds: [sourceRecord.id],
              },
            ],
          },
        },
      },
      entities: [...(base.entities ?? []), related],
      metadata: [
        ...base.metadata,
        {
          target: { kind: "entity" as const, entityId: related.id },
          property: "asset.related-only-title",
          sourceSlot: "source.related.title",
          value: "Only related",
          sourceRecordIds: [sourceRecord.id],
        },
      ],
      artifacts: [...base.artifacts, { id: "related-observed-artifact" }],
      locations: [
        ...base.locations,
        {
          id: "related-observed-location",
          artifactId: "related-observed-artifact",
          address: "/observed/related-only",
          kind: "observed",
        },
      ],
      artifactAssociations: [
        ...base.artifactAssociations,
        {
          id: "related-observed-association",
          target: { kind: "entity", entityId: related.id },
          artifactId: "related-observed-artifact",
          role: "asset.primary-cover",
          sourceRecordIds: [sourceRecord.id],
        },
      ],
      relationships: [
        ...(base.relationships ?? []),
        {
          id: "related-only-relationship",
          participants: [
            { entityId: related.id, role: "asset" },
            { entityId: related.id, role: "related" },
          ],
          type: "asset.contribution",
          sourceSlot: "source.related.relationship",
          sourceRecordIds: [sourceRecord.id],
          qualifiers: [],
        },
      ],
    };
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [sourceRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: fact,
    });

    const [facts] = await catalogue.readCurrentInformationSubjectFacts({
      subjectIds: ["asset"],
    });

    expect(facts).toMatchObject({
      subjectId: "asset",
      sourceAssociations: [{ id: "association", sourceIdentity: "source" }],
      metadata: [expect.objectContaining({ subjectId: "asset" })],
      relationships: [expect.objectContaining({ subjectId: "asset" })],
      artifactAssociations: [
        expect.objectContaining({
          subjectId: "asset",
          managedLocations: [{ address: "/managed/blob" }],
        }),
      ],
    });
    expect(facts?.metadata).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectId: related.id }),
      ]),
    );
    expect(facts?.relationships).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectId: related.id }),
      ]),
    );
    expect(facts?.artifactAssociations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectId: related.id }),
      ]),
    );
    catalogue.close();
  });

  it("rolls back a managed source-cover replacement when its terminal execution cannot be recorded", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const sourceRecord = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "managed-source-record",
      body: "{}",
    };
    const initialAccepted = accepted();
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [sourceRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: {
        ...initialAccepted,
        artifacts: [],
        locations: [],
        blobs: [],
        artifactRevisions: [],
        artifactAssociations: [],
      },
    });
    await saveCurrentAttentionPreview(catalogue, {
      executionId: "managed-artifact-preview-owner",
      previewId: "managed-artifact-sibling-preview",
      accepted: (await catalogue.inspectExecution("execution"))!.accepted!,
    });

    const managedFacts = (id: string) => ({
      artifacts: [{ id: `managed-artifact-${id}` }],
      locations: [
        {
          id: `managed-location-${id}`,
          artifactId: `managed-artifact-${id}`,
          address: `/managed/${id}`,
          kind: "managed" as const,
        },
      ],
      blobs: [
        {
          digest: `managed-digest-${id}`,
          mediaType: "image/jpeg",
          byteLength: 4,
        },
      ],
      revisions: [
        {
          id: `managed-revision-${id}`,
          artifactId: `managed-artifact-${id}`,
          blobDigest: `managed-digest-${id}`,
        },
      ],
      associations: [
        {
          id: `managed-association-${id}`,
          target: { kind: "entity", entityId: "asset" },
          artifactId: `managed-artifact-${id}`,
          role: "asset.primary-cover",
          sourceRecordIds: ["record"],
        },
      ],
    });
    const initialExecution: WorkflowExecution = {
      ...execution(),
      id: "managed-source-initial",
      acceptedAssetId: "asset",
      sourceRecordIds: ["record"],
      stage: "source-artifacts-stored",
    };
    await catalogue.createExecution(initialExecution);
    await catalogue.submitManagedSourceArtifacts({
      expectedExecution: await executionBaseline(
        catalogue,
        initialExecution.id,
      ),
      execution: {
        ...initialExecution,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
      },
      expectedIdentity: {
        subjectId: "asset",
        recognitionDecisionId: "decision",
        sourceAssociationId: "association",
      },
      sourceRecordIds: ["record"],
      managedArtifacts: managedFacts("old"),
    });
    await expect(
      catalogue.inspectChangeImpactPreview("managed-artifact-sibling-preview"),
    ).resolves.toMatchObject({ status: "stale" });

    const replacementExecution: WorkflowExecution = {
      ...initialExecution,
      id: "managed-source-replacement",
    };
    await catalogue.createExecution(replacementExecution);
    await expect(
      catalogue.submitManagedSourceArtifacts({
        expectedExecution: await executionBaseline(
          catalogue,
          replacementExecution.id,
        ),
        // 最终效果绝不能覆盖无关执行。
        execution: {
          ...replacementExecution,
          id: "missing-terminal-execution",
          status: "completed",
          stage: "completed",
          outcome: "accepted",
        },
        expectedIdentity: {
          subjectId: "asset",
          recognitionDecisionId: "decision",
          sourceAssociationId: "association",
        },
        sourceRecordIds: ["record"],
        managedArtifacts: managedFacts("new"),
      }),
    ).rejects.toThrow("execution baseline is stale or terminal");

    const terminalUpdateGuard = new DatabaseSync(
      path.join(root, "catalogue.sqlite"),
    );
    try {
      terminalUpdateGuard.exec(`CREATE TRIGGER fail_managed_terminal_update
        BEFORE UPDATE ON workflow_executions
        WHEN NEW.id = 'managed-source-replacement'
        BEGIN
          SELECT RAISE(ABORT, 'forced terminal execution update failure');
        END`);
    } finally {
      terminalUpdateGuard.close();
    }
    await expect(
      catalogue.submitManagedSourceArtifacts({
        expectedExecution: await executionBaseline(
          catalogue,
          replacementExecution.id,
        ),
        // 该失败发生在本应写入候选事实/溯源之后，证明同一个 Drizzle 事务会把它们
        // 连同执行检查点一并回滚。
        execution: {
          ...replacementExecution,
          status: "completed",
          stage: "completed",
          outcome: "accepted",
        },
        expectedIdentity: {
          subjectId: "asset",
          recognitionDecisionId: "decision",
          sourceAssociationId: "association",
        },
        sourceRecordIds: ["record"],
        managedArtifacts: managedFacts("new"),
      }),
    ).rejects.toThrow("forced terminal execution update failure");

    await expect(
      catalogue.findAcceptedForSubjects(["asset"]),
    ).resolves.toMatchObject([
      {
        accepted: {
          artifactAssociations: [
            expect.objectContaining({
              id: "managed-association-old",
              sourceAssociationId: "association",
            }),
          ],
        },
      },
    ]);
    await expect(
      catalogue.inspectExecution(replacementExecution.id),
    ).resolves.toMatchObject({
      execution: { status: "running", stage: "source-artifacts-stored" },
    });

    const ledger = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      expect(
        ledger
          .prepare(
            `SELECT aa.id FROM artifact_associations aa
             WHERE aa.subject_id = ? AND aa.role = ?
               AND NOT EXISTS (
                 SELECT 1 FROM artifact_association_supersessions s
                 WHERE s.predecessor_association_id = aa.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM artifact_association_retractions r
                 WHERE r.association_id = aa.id
               )`,
          )
          .all("asset", "asset.primary-cover"),
      ).toEqual([{ id: "managed-association-old" }]);
      expect(
        ledger
          .prepare(
            `SELECT COUNT(*) AS count FROM artifact_association_supersessions`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        ledger
          .prepare(
            `SELECT COUNT(*) AS count FROM artifact_associations WHERE id = ?`,
          )
          .get("managed-association-new"),
      ).toEqual({ count: 0 });
    } finally {
      ledger.close();
    }
    catalogue.close();
  });

  it("retains producer capability declarations with source and accepted facts across a restart", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const collector = {
      capabilityId: "test.collector",
      capabilityVersion: "2",
      contractVersion: "source-record/v2",
      identity: "test.collector",
      implementationVersion: "2",
      kind: "source-collector",
      interpretationContractVersions: ["source-record/v2"],
    } as const;
    const interpreter = {
      capabilityId: "test.interpreter",
      capabilityVersion: "3",
      contractVersion: "interpretation/v3",
      identity: "test.interpreter",
      implementationVersion: "3",
      kind: "source-interpreter",
      interpretationContractVersions: ["interpretation/v3"],
    } as const;
    const recognizer = {
      capabilityId: "test.recognizer",
      capabilityVersion: "4",
      contractVersion: "recognition/v4",
      identity: "test.recognizer",
      implementationVersion: "4",
      kind: "recognizer",
      interpretationContractVersions: ["recognition/v4"],
    } as const;
    const acquirer = {
      capabilityId: "test.acquirer",
      capabilityVersion: "5",
      contractVersion: "artifact/v5",
      identity: "test.acquirer",
      implementationVersion: "5",
      kind: "source-artifact-acquirer",
      interpretationContractVersions: ["artifact/v5"],
    } as const;
    const formatInspector = {
      capabilityId: "test.format-inspector",
      capabilityVersion: "6",
      contractVersion: "format-inspection/v6",
      identity: "test.format-inspector",
      implementationVersion: "6",
      kind: "format-inspector",
      interpretationContractVersions: ["format-inspection/v6"],
    } as const;
    const formatReuseCompatibility = {
      workflowVersion: "asset-refresh/2" as const,
      policyVersion: "producer-retention/1",
      capabilityCoordinates: ["test.format-inspector@6/format-inspection/v6"],
    };
    const formatWorkItem = {
      key: "format-boundary",
      relativePaths: ["observed-container"],
      reuseFingerprint: "format-boundary-fingerprint",
      reuseCompatibility: formatReuseCompatibility,
      sourceRecordIds: ["record"],
      proposalId: "proposal",
      acceptedAssetId: "asset",
      outcome: "accepted" as const,
    };
    const observedPartAcquirer = {
      capabilityId: "test.observed-part-acquirer",
      capabilityVersion: "7",
      contractVersion: "observed-part/v7",
      identity: "test.observed-part-acquirer",
      implementationVersion: "7",
      kind: "observed-artifact-part-acquirer",
      interpretationContractVersions: ["observed-part/v7"],
    } as const;
    const record = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: "{}",
      producer: collector,
    };
    const base = accepted();
    const interpretation = {
      ...base.proposal.basis.interpretation,
      producer: interpreter,
      metadata: base.proposal.basis.interpretation.metadata.map(
        (assertion) => ({
          ...assertion,
          producer: interpreter,
        }),
      ),
      entities: base.proposal.basis.interpretation.entities?.map((entity) => ({
        ...entity,
        producer: interpreter,
      })),
      entityMentions: base.proposal.basis.interpretation.entityMentions?.map(
        (mention) => ({ ...mention, producer: interpreter }),
      ),
      entityResolutionDecisions:
        base.proposal.basis.interpretation.entityResolutionDecisions?.map(
          (decision) => ({ ...decision, producer: interpreter }),
        ),
    };
    const ruleResults = base.proposal.ruleResults.map((result) => ({
      ...result,
      evidence: [
        {
          kind: "source-address",
          explanation: "recognized from the persisted source record",
          producer: recognizer,
        },
      ],
    }));
    const observedParent = { id: "observed-parent" };
    const observedPart = { id: "observed-part" };
    const observedParentRevision = {
      id: "observed-parent-revision",
      artifactId: observedParent.id,
      blobDigest: "observed-parent-digest",
      producer: formatInspector,
    };
    const materializedObservedPartRevision = {
      id: "observed-part-revision",
      artifactId: observedPart.id,
      blobDigest: "observed-part-digest",
      producer: observedPartAcquirer,
    };
    const materializedObservedPartAssociation = {
      id: "observed-part-association",
      target: { kind: "entity" as const, entityId: base.entity.id },
      artifactId: observedPart.id,
      role: "asset.primary-cover" as const,
      producer: observedPartAcquirer,
      observedArtifactPart: {
        artifactId: observedParent.id,
        revisionId: observedParentRevision.id,
        locator: "format:cover",
      },
    };
    const observedMetadata = {
      target: {
        kind: "artifact-revision" as const,
        artifactId: observedParent.id,
        revisionId: observedParentRevision.id,
      },
      property: "asset.title",
      sourceSlot: "format.title",
      value: "Observed local title",
      sourceRecordIds: [],
      producer: formatInspector,
      observedArtifactPart: {
        artifactId: observedParent.id,
        revisionId: observedParentRevision.id,
        locator: "format:title",
      },
    };
    const fact: AcceptedRecognition = {
      ...base,
      proposal: {
        ...base.proposal,
        basis: { kind: "source-interpretation", interpretation },
        ruleResults,
      },
      recognitionDecision: {
        ...base.recognitionDecision,
        acceptedRuleResults: ruleResults,
      },
      metadata: [
        ...interpretation.metadata.map((assertion) => ({
          ...assertion,
          target: { kind: "entity" as const, entityId: base.entity.id },
        })),
        observedMetadata,
      ],
      entities: base.entities?.map((entity) => ({
        ...entity,
        producer: interpreter,
      })),
      entityMentions: interpretation.entityMentions,
      entityResolutionDecisions: interpretation.entityResolutionDecisions,
      relationships: base.relationships?.map((relationship) => ({
        ...relationship,
        producer: interpreter,
      })),
      artifacts: [...base.artifacts, observedParent, observedPart],
      locations: [
        ...base.locations,
        {
          id: "observed-parent-location",
          artifactId: observedParent.id,
          address: "/observed/container",
          kind: "observed",
        },
        {
          id: "observed-part-location",
          artifactId: observedPart.id,
          address: "/managed/observed-cover",
          kind: "managed",
        },
      ],
      blobs: [
        ...base.blobs,
        {
          digest: observedParentRevision.blobDigest,
          mediaType: "application/x-test-container",
          byteLength: 12,
        },
        {
          digest: materializedObservedPartRevision.blobDigest,
          mediaType: "image/jpeg",
          byteLength: 4,
        },
      ],
      artifactRevisions: [
        ...base.artifactRevisions.map((revision) => ({
          ...revision,
          producer: acquirer,
        })),
        observedParentRevision,
        materializedObservedPartRevision,
      ],
      artifactAssociations: [
        ...base.artifactAssociations.map((association) => ({
          ...association,
          producer: interpreter,
        })),
        materializedObservedPartAssociation,
      ],
    };

    await catalogue.createExecution({
      ...execution(),
      compatibility: formatReuseCompatibility,
      dispositions: [],
      workItems: [formatWorkItem],
    });
    await retainSourceRecords(catalogue, "execution", [record]);
    await acceptRecognition(catalogue, {
      execution: {
        ...acceptedExecution(),
        compatibility: formatReuseCompatibility,
        dispositions: [],
        workItems: [formatWorkItem],
      },
      accepted: fact,
    });
    catalogue.close();

    const reopened = SqliteCatalogue.forProductData(root);
    const inspection = await reopened.inspectExecution("execution");
    expect(inspection?.sourceRecords[0]?.producer).toEqual(collector);
    expect(inspection?.accepted).toMatchObject({
      proposal: {
        basis: {
          interpretation: { producer: interpreter },
        },
        ruleResults: [{ evidence: [{ producer: recognizer }] }],
      },
      entities: [{ producer: interpreter }],
      entityMentions: [{ producer: interpreter }],
      entityResolutionDecisions: [{ producer: interpreter }],
      relationships: [{ producer: interpreter }],
    });
    expect(inspection?.accepted?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ producer: interpreter }),
        expect.objectContaining({
          sourceSlot: observedMetadata.sourceSlot,
          producer: formatInspector,
          observedArtifactPart: observedMetadata.observedArtifactPart,
        }),
      ]),
    );
    expect(inspection?.accepted?.artifactRevisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "revision", producer: acquirer }),
        expect.objectContaining({
          id: observedParentRevision.id,
          producer: formatInspector,
        }),
        expect.objectContaining({
          id: materializedObservedPartRevision.id,
          producer: observedPartAcquirer,
        }),
      ]),
    );
    expect(inspection?.accepted?.artifactAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ producer: interpreter }),
        expect.objectContaining({
          id: materializedObservedPartAssociation.id,
          producer: observedPartAcquirer,
          observedArtifactPart: {
            artifactId: observedParent.id,
            revisionId: observedParentRevision.id,
            locator: "format:cover",
          },
        }),
      ]),
    );
    expect(inspection?.execution.workItems).toEqual([
      expect.objectContaining({
        key: formatWorkItem.key,
        reuseCompatibility: formatReuseCompatibility,
      }),
    ]);
    await expect(
      reopened.findReusableWorkItem({
        directory: "/observed",
        relativePaths: formatWorkItem.relativePaths,
        reuseFingerprint: formatWorkItem.reuseFingerprint,
        availableCompatibility: formatReuseCompatibility,
      }),
    ).resolves.toMatchObject({
      reuseCompatibility: formatReuseCompatibility,
    });
    reopened.close();
  });

  it("persists independently committed work-item audit references across catalogue instances", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const initial = {
      ...execution(),
      workItems: [
        {
          key: "first-boundary",
          relativePaths: ["first.bin"],
          observedArtifactBoundary: "filesystem-package" as const,
          observedArtifactBoundaryProducer: {
            capabilityId: "filesystem.package",
            capabilityVersion: "2",
            contractVersion: "3",
          },
          sourceRecordIds: ["first-record"],
          proposalId: "first-proposal",
          acceptedAssetId: "first-asset",
          outcome: "accepted" as const,
        },
        {
          key: "second-boundary",
          relativePaths: ["second.bin"],
          sourceRecordIds: ["second-record"],
          outcome: "failed" as const,
          reason: "official source unavailable",
        },
      ],
    };
    await catalogue.createExecution(initial);
    await catalogue.finishExecution(initial, {
      ...initial,
      status: "completed",
      stage: "completed",
      outcome: "accepted",
    });
    catalogue.close();

    const later = SqliteCatalogue.forProductData(root);
    await expect(later.inspectExecution("execution")).resolves.toMatchObject({
      execution: {
        workItems: initial.workItems,
      },
    });
    later.close();
  });

  it("reopens a subject-only selection audit without a fabricated directory or snapshot", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const selection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [
        {
          subjectId: "episode-b",
          explanations: [{ path: ["Series", "Episode B"] }],
        },
      ],
      filesystemScopes: [],
    };
    const initial: WorkflowExecution = {
      id: "subject-only",
      selection: {
        intent: "metadata-refresh",
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [],
          artifactRoles: [],
          relationshipTypes: [],
        },
      },
      operationKind: "refresh-metadata",
      requestedSelection: selection,
      resolvedSelection: selection,
      filesystemSnapshots: [],
      targetDispositions: [
        {
          key: "subject:episode-b",
          target: { kind: "subject", subjectId: "episode-b" },
          status: "blocked",
          reason: "no current Source Association",
          sourceRecordIds: ["partial-episode-b"],
          outputReferences: ["partial-episode-b"],
        },
      ],
      status: "failed",
      stage: "failed",
      outcome: "failed",
      sourceRecordIds: [],
      compatibility: {
        workflowVersion: "asset-refresh/2",
        policyVersion: "policy/1",
        capabilityCoordinates: [],
      },
      dispositions: [],
    };
    await catalogue.createExecution(initial);
    catalogue.close();

    const later = SqliteCatalogue.forProductData(root);
    const reopened = await later.inspectExecution("subject-only");
    expect(reopened?.execution).toMatchObject({
      operationKind: "refresh-metadata",
      requestedSelection: selection,
      resolvedSelection: selection,
      filesystemSnapshots: [],
      targetDispositions: initial.targetDispositions,
    });
    expect(reopened?.execution.selection.directory).toBeUndefined();
    expect(reopened?.execution.snapshot).toBeUndefined();
    later.close();
  });

  it("keeps a legacy root-only selection inspectable but requires a newly selected registered scope for recovery", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const workflow = recoveryWorkflow(catalogue);
    const executionId = "legacy-root-only-recovery";
    await expect(
      scanFixtureRegisteredObservedScope(workflow, {
        directory: "/observed/legacy-boundary",
        executionId,
        acceptTrusted: true,
        onCheckpoint() {
          throw new Error("simulated legacy process interruption");
        },
      }),
    ).rejects.toThrow("simulated legacy process interruption");

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const durable = database
      .prepare("SELECT audit_json FROM workflow_executions WHERE id = ?")
      .get(executionId) as { readonly audit_json: string };
    const audit = JSON.parse(durable.audit_json) as {
      readonly payload: Record<string, unknown>;
    };
    const legacySelection = {
      version: "asset-refresh-selection/1",
      subjects: [],
      filesystemScopes: [
        {
          root: "/observed/legacy-boundary",
          explanations: [{ path: ["legacy", "root-only"] }],
        },
      ],
    };
    audit.payload.requestedSelection = legacySelection;
    audit.payload.resolvedSelection = legacySelection;
    database
      .prepare(
        "UPDATE workflow_executions SET requested_selection_json = ?, resolved_selection_json = ?, audit_json = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(legacySelection),
        JSON.stringify(legacySelection),
        JSON.stringify(audit),
        executionId,
      );
    database.close();

    const inspectable = await catalogue.inspectExecution(executionId);
    expect(inspectable?.execution.selection.directory).toBe(
      "/observed/legacy-boundary",
    );
    expect(inspectable?.execution.requestedSelection).toBeUndefined();
    expect(inspectable?.execution.resolvedSelection).toBeUndefined();

    await expect(workflow.resume({ executionId })).resolves.toMatchObject({
      execution: {
        status: "failed",
        outcome: "interrupted",
        reason:
          "刷新记录使用旧版未登记文件位置范围，无法安全继续；请重新选择范围并刷新",
      },
    });
    await workflow.close();
  });

  it("fails visibly when nested Asset Refresh audit elements are malformed", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution({
      ...execution(),
      requestedSelection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: "episode-b",
            explanations: [{ path: ["Episode B"] }],
          },
        ],
        filesystemScopes: [],
      },
    });
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    database
      .prepare(
        "UPDATE workflow_executions SET requested_selection_json = ? WHERE id = ?",
      )
      .run(
        '{"version":"asset-refresh-selection/1","subjects":[{"subjectId":"episode-b","explanations":[{"path":["Episode B",7]}]}],"filesystemScopes":[]}',
        "execution",
      );

    await expect(catalogue.inspectExecution("execution")).rejects.toThrow(
      "Malformed Asset Refresh audit column requested_selection_json",
    );

    database
      .prepare(
        "UPDATE workflow_executions SET requested_selection_json = NULL, target_dispositions_json = ? WHERE id = ?",
      )
      .run(
        '[{"key":"subject:episode-b","target":{"kind":"subject","subjectId":7},"status":"failed"}]',
        "execution",
      );
    await expect(catalogue.inspectExecution("execution")).rejects.toThrow(
      "Malformed Asset Refresh audit column target_dispositions_json",
    );

    database
      .prepare(
        "UPDATE workflow_executions SET target_dispositions_json = NULL, filesystem_snapshots_json = ? WHERE id = ?",
      )
      .run(
        '[{"id":"snapshot","root":"/media","complete":true,"files":[{"relativePath":"episode.mkv","size":"large","modifiedAt":"2026-07-30T00:00:00.000Z"}],"excluded":[],"observedAt":"2026-07-30T00:00:00.000Z"}]',
        "execution",
      );
    database.close();
    await expect(catalogue.inspectExecution("execution")).rejects.toThrow(
      "Malformed Asset Refresh audit column filesystem_snapshots_json",
    );
  });

  it("atomically claims concurrent resume and rejects an expired stale owner", async () => {
    let authoritativeNow = new Date("2026-07-29T00:00:00.000Z");
    const clock = { now: () => authoritativeNow };
    const { root, catalogue: first } = await createCatalogueWithRoot({ clock });
    await first.createExecution(execution());
    const second = SqliteCatalogue.forProductData(root, {
      clock,
    });

    await expect(
      Promise.all([
        first.claimResumeExecution({
          executionId: "execution",
          token: "first",
          now: "2026-07-29T00:00:00.000Z",
          expiresAt: "2026-07-29T00:00:20.000Z",
        }),
        second.claimResumeExecution({
          executionId: "execution",
          token: "second",
          now: "2026-07-29T00:00:00.000Z",
          expiresAt: "2026-07-29T00:00:20.000Z",
        }),
      ]),
    ).resolves.toEqual(expect.arrayContaining(["claimed", "busy"]));

    authoritativeNow = new Date("2026-07-29T00:00:21.000Z");
    const takeover = await second.claimResumeExecution({
      executionId: "execution",
      token: "winner",
      now: "2026-07-29T00:00:21.000Z",
      expiresAt: "2026-07-29T00:00:41.000Z",
    });
    expect(takeover).toBe("claimed");
    const finished = {
      ...execution(),
      status: "failed" as const,
      stage: "failed" as const,
      outcome: "failed" as const,
      reason: "stale owner",
    };
    await expect(
      first.finishExecution(execution(), finished, {
        token: "first",
        now: "2026-07-29T00:00:21.000Z",
      }),
    ).rejects.toThrow("stale resume claim");
    await expect(
      second.finishExecution(
        execution(),
        { ...finished, reason: "winner" },
        { token: "winner", now: "2026-07-29T00:00:21.000Z" },
      ),
    ).resolves.toBeUndefined();
    await expect(second.inspectExecution("execution")).resolves.toMatchObject({
      execution: { reason: "winner" },
    });
    first.close();
    second.close();
  });

  it("rejects replayed caller time after the authoritative resume lease has expired", async () => {
    let authoritativeNow = new Date("1999-01-01T00:00:00.000Z");
    const { root } = await createCatalogueWithRoot();
    const catalogue = SqliteCatalogue.forProductData(root, {
      clock: { now: () => authoritativeNow },
    });
    const initial = execution();
    await catalogue.createExecution(initial);
    await expect(
      catalogue.claimResumeExecution({
        executionId: initial.id,
        token: "expired-owner",
        now: "1999-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:00:00.000Z",
      }),
    ).resolves.toBe("claimed");
    const before = await catalogue.inspectExecution(initial.id);

    // 恢复进程可以重放旧时间戳，但 SQLite 目录已经远远超过持久租约的到期时间。
    authoritativeNow = new Date("2026-08-02T00:00:00.000Z");
    const terminal = {
      ...initial,
      status: "failed" as const,
      stage: "failed" as const,
      outcome: "failed" as const,
      reason: "expired owner must not finish",
    };
    const checkpoint = {
      ...initial,
      dispositions: [
        {
          key: "filesystem:/observed",
          status: "running" as const,
          reason: "expired owner must not checkpoint",
        },
      ],
    };

    await expect(
      catalogue.finishExecution(initial, terminal, {
        token: "expired-owner",
        now: "1999-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("stale resume claim");
    await expect(
      catalogue.transitionExecution(initial, checkpoint, {
        token: "expired-owner",
        now: "1999-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("stale resume claim");
    await expect(catalogue.inspectExecution(initial.id)).resolves.toEqual(
      before,
    );
    catalogue.close();
  });

  it("keeps an unexpired authoritative resume owner able to transition", async () => {
    let authoritativeNow = new Date("1999-01-01T00:00:00.000Z");
    const { root } = await createCatalogueWithRoot();
    const catalogue = SqliteCatalogue.forProductData(root, {
      clock: { now: () => authoritativeNow },
    });
    const initial = execution();
    await catalogue.createExecution(initial);
    await catalogue.claimResumeExecution({
      executionId: initial.id,
      token: "current-owner",
      now: "1999-01-01T00:00:00.000Z",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    authoritativeNow = new Date("1999-06-01T00:00:00.000Z");

    await expect(
      catalogue.transitionExecution(
        initial,
        {
          ...initial,
          dispositions: [
            {
              key: "filesystem:/observed",
              status: "running",
              reason: "current owner checkpoint",
            },
          ],
        },
        {
          token: "current-owner",
          // 此时间刻意过期：有效性以目录时钟为准，而不是任意调用方时间戳。
          now: "1900-01-01T00:00:00.000Z",
        },
      ),
    ).resolves.toBeUndefined();
    catalogue.close();
  });

  it("does not renew or release an expired lease with a replayed application timestamp", async () => {
    let authoritativeNow = new Date("1999-01-01T00:00:00.000Z");
    const { root } = await createCatalogueWithRoot();
    const catalogue = SqliteCatalogue.forProductData(root, {
      clock: { now: () => authoritativeNow },
    });
    const initial = execution();
    await catalogue.createExecution(initial);
    await catalogue.claimResumeExecution({
      executionId: initial.id,
      token: "expired-owner",
      now: "1999-01-01T00:00:00.000Z",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    authoritativeNow = new Date("2026-08-02T00:00:00.000Z");

    await expect(
      catalogue.renewResumeExecutionClaim({
        executionId: initial.id,
        token: "expired-owner",
        now: "1999-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).resolves.toBe(false);
    await catalogue.releaseResumeExecutionClaim({
      executionId: initial.id,
      token: "expired-owner",
    });

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      database
        .prepare(
          "SELECT resume_claim_token, resume_claim_expires_at FROM workflow_executions WHERE id = ?",
        )
        .get(initial.id),
    ).toEqual({
      resume_claim_token: "expired-owner",
      resume_claim_expires_at: "2000-01-01T00:00:00.000Z",
    });
    database.close();
    catalogue.close();
  });

  it("reclaims a malformed recovery claim without an expiry instead of leaving an execution permanently busy", async () => {
    const { root, catalogue } = await createCatalogueWithRoot({
      clock: { now: () => new Date("2026-07-29T00:00:00.000Z") },
    });
    await catalogue.createExecution(execution());
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    database
      .prepare(
        "UPDATE workflow_executions SET resume_claim_token = ?, resume_claim_expires_at = NULL WHERE id = ?",
      )
      .run("interrupted-owner", "execution");
    database.close();

    await expect(
      catalogue.claimResumeExecution({
        executionId: "execution",
        token: "recovery-owner",
        now: "2026-07-29T00:00:00.000Z",
        expiresAt: "2026-07-29T00:00:20.000Z",
      }),
    ).resolves.toBe("claimed");
  });

  it("rejects a same-stage stale checkpoint instead of overwriting a concurrent disposition", async () => {
    const { catalogue } = await createCatalogueWithRoot();
    const initial = execution();
    await catalogue.createExecution(initial);
    const concurrent = {
      ...initial,
      dispositions: [
        {
          key: "filesystem:/observed",
          status: "running" as const,
          reason: "concurrent durable checkpoint",
        },
      ],
    };
    await catalogue.transitionExecution(initial, concurrent);
    const staleTerminal = {
      ...initial,
      status: "completed" as const,
      stage: "completed" as const,
      outcome: "no-change" as const,
    };

    await expect(
      catalogue.transitionExecution(initial, staleTerminal),
    ).rejects.toThrow("execution baseline is stale");
    await expect(catalogue.inspectExecution(initial.id)).resolves.toMatchObject(
      {
        execution: {
          status: "running",
          stage: initial.stage,
          dispositions: concurrent.dispositions,
        },
      },
    );
  });

  it("rejects a stale terminal completion instead of overwriting a same-stage checkpoint", async () => {
    const { catalogue } = await createCatalogueWithRoot();
    const initial = execution();
    await catalogue.createExecution(initial);
    const concurrent = {
      ...initial,
      dispositions: [
        {
          key: "filesystem:/observed",
          status: "running" as const,
          reason: "concurrent durable checkpoint",
        },
      ],
    };
    await catalogue.transitionExecution(initial, concurrent);
    const staleTerminal = {
      ...initial,
      status: "completed" as const,
      stage: "completed" as const,
      outcome: "no-change" as const,
    };

    await expect(
      catalogue.finishExecution(initial, staleTerminal),
    ).rejects.toThrow("execution baseline is stale");
    await expect(catalogue.inspectExecution(initial.id)).resolves.toMatchObject(
      {
        execution: {
          status: "running",
          stage: initial.stage,
          dispositions: concurrent.dispositions,
        },
      },
    );
  });

  it("cancels with a full audit CAS without rolling back retained evidence or honoring a late worker", async () => {
    const catalogue = await createCatalogue({
      clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
    });
    const initial = execution();
    await catalogue.createExecution(initial);
    await retainSourceRecords(catalogue, initial.id, [sourceRecord()]);
    const expected = await executionBaseline(catalogue, initial.id);

    await expect(
      catalogue.cancelExecution({
        expectedExecution: expected,
        execution: {
          ...expected,
          status: "failed",
          stage: "failed",
          outcome: "cancelled",
          cancellation: {
            requestedBy: "user-1",
            requestedAt: "not-an-instant",
          },
        },
      }),
    ).rejects.toThrow("terminal and attributable");
    await expect(catalogue.inspectExecution(initial.id)).resolves.toMatchObject(
      { execution: { status: "running" } },
    );

    await expect(
      catalogue.claimResumeExecution({
        executionId: initial.id,
        token: "active-worker",
        now: "2026-08-02T00:00:00.000Z",
        expiresAt: "2026-08-02T00:01:00.000Z",
      }),
    ).resolves.toBe("claimed");

    const cancelled = {
      ...expected,
      status: "failed" as const,
      stage: "failed" as const,
      outcome: "cancelled" as const,
      reason: "user stopped this refresh",
      cancellation: {
        requestedBy: "user-1",
        requestedAt: "2026-08-02T00:00:10.000Z",
        reason: "user stopped this refresh",
      },
    };
    await catalogue.cancelExecution({
      expectedExecution: expected,
      execution: cancelled,
    });

    await expect(catalogue.inspectExecution(initial.id)).resolves.toMatchObject(
      {
        execution: {
          status: "failed",
          stage: "failed",
          outcome: "cancelled",
          cancellation: {
            requestedBy: "user-1",
            requestedAt: "2026-08-02T00:00:10.000Z",
          },
        },
        sourceRecords: [{ id: "record" }],
      },
    );
    await expect(
      catalogue.renewResumeExecutionClaim({
        executionId: initial.id,
        token: "active-worker",
        now: "2026-08-02T00:00:10.000Z",
        expiresAt: "2026-08-02T00:01:10.000Z",
      }),
    ).resolves.toBe(false);

    const lateRecord = {
      ...sourceRecord(),
      id: "late-record",
      acquiredAt: "2026-08-02T00:00:11.000Z",
    };
    await expect(
      catalogue.retainSourceRecords({
        expectedExecution: expected,
        execution: {
          ...expected,
          sourceRecordIds: [...expected.sourceRecordIds, lateRecord.id],
        },
        sourceRecords: [lateRecord],
        resumeClaim: {
          token: "active-worker",
          now: "2026-08-02T00:00:11.000Z",
        },
      }),
    ).rejects.toThrow("execution baseline is stale or terminal");
    await expect(catalogue.inspectExecution(initial.id)).resolves.toMatchObject(
      { sourceRecords: [{ id: "record" }] },
    );
  });
});

function execution(): WorkflowExecution {
  return {
    id: "execution",
    selection: { directory: "/observed" },
    snapshot: {
      id: "snapshot",
      root: "/observed",
      complete: true,
      excluded: [],
      files: [],
      observedAt: "2026-07-29T00:00:00.000Z",
    },
    status: "running",
    stage: "recognition",
    sourceRecordIds: [],
  };
}

function sourceRecord() {
  return {
    id: "record",
    sourceIdentity: "source",
    nativeAddress: "https://source.example/work",
    mediaType: "application/json",
    acquiredAt: "2026-07-29T00:00:00.000Z",
    acquisition: {
      requestedAddress: "https://source.example/work.json",
      method: "GET" as const,
      authorized: false,
    },
    coverage: {
      id: "complete",
      completeness: "complete" as const,
      authority: "official" as const,
    },
    digest: "digest",
    body: "{}",
  };
}

function sourceAssociationEstablishment(input: {
  readonly id: string;
  readonly subjectId: string;
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
  readonly sourceRecordIds: readonly string[];
}): {
  readonly proposal: SourceAssociationChangeProposal;
  readonly decision: SourceAssociationDecision;
} {
  const proposal: SourceAssociationChangeProposal = {
    id: `source-association-proposal:${input.id}`,
    kind: "establish",
    subjectId: input.subjectId,
    successor: {
      id: input.id,
      subjectId: input.subjectId,
      sourceIdentity: input.sourceIdentity,
      nativeAddress: input.nativeAddress,
    },
    sourceRecordIds: input.sourceRecordIds,
    proposedBy: {
      kind: "capability",
      coordinate: {
        capabilityId: "composition.test-source-association",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    },
    evidence: {
      observed: [],
      manual: [],
      sourceCandidates: [
        {
          outcome: "accepted",
          sourceIdentity: input.sourceIdentity,
          nativeAddress: input.nativeAddress,
          sourceRecordIds: input.sourceRecordIds,
          ruleResults: [],
          explanation: "测试来源关联与当前地址一致",
        },
      ],
      conflicts: [],
    },
  };
  return {
    proposal,
    decision: {
      id: `source-association-decision:${input.id}`,
      proposalId: proposal.id,
      subjectId: input.subjectId,
      decidedBy: {
        kind: "application-policy",
        policyCoordinate: "composition/test-source-association/1",
      },
    },
  };
}

function insertCurrentSourceAssociation(
  database: DatabaseSync,
  input: {
    readonly id: string;
    readonly subjectId: string;
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  },
): void {
  const { proposal, decision } = sourceAssociationEstablishment({
    ...input,
    sourceRecordIds: [],
  });
  database
    .prepare(
      "INSERT INTO source_associations (id, subject_id, source_identity, native_address) VALUES (?, ?, ?, ?)",
    )
    .run(input.id, input.subjectId, input.sourceIdentity, input.nativeAddress);
  database
    .prepare(
      `INSERT INTO source_association_change_proposals (
        id, subject_id, kind, payload_json, proposed_by_json, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      proposal.id,
      proposal.subjectId,
      proposal.kind,
      JSON.stringify(proposal),
      JSON.stringify(proposal.proposedBy),
      JSON.stringify(proposal.evidence),
    );
  database
    .prepare(
      `INSERT INTO source_association_decisions (
        id, proposal_id, subject_id, decided_by_kind, decided_by_coordinate
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      decision.id,
      decision.proposalId,
      decision.subjectId,
      decision.decidedBy.kind,
      decision.decidedBy.kind === "user"
        ? decision.decidedBy.actorId
        : decision.decidedBy.policyCoordinate,
    );
  database
    .prepare(
      `INSERT INTO source_association_establishment_supports (
        association_id, recognition_decision_id, source_association_decision_id
      ) VALUES (?, NULL, ?)`,
    )
    .run(input.id, decision.id);
  database
    .prepare(
      "INSERT INTO current_source_associations (subject_id, association_id) VALUES (?, ?)",
    )
    .run(input.subjectId, input.id);
}

function accepted(): AcceptedRecognition {
  const interpretation = {
    id: "interpretation",
    producer: {
      capabilityId: "interpreter",
      capabilityVersion: "1",
      contractVersion: "1",
    },
    sourceRecordIds: ["record"],
    sourceIdentity: "source",
    sourceAddress: "https://source.example/work",
    metadata: [
      {
        property: "asset.title",
        sourceSlot: "source.title",
        value: "Work",
        sourceRecordIds: ["record"],
        qualifiers: [
          { key: "rating.source-label", value: "Internet Movie Database" },
          { key: "rating.unit", value: "score" },
        ],
      },
    ],
    sourceArtifacts: [],
    entities: [
      {
        id: "persona",
        kind: "persona" as const,
        sourceIdentity: "source",
        sourceKey: "credited-name",
        identityNamespace: "source.credit.voice",
        label: "Credited name",
        sourceRecordIds: ["record"],
      },
    ],
    entityMentions: [
      {
        id: "mention",
        sourceRecordIds: ["record"],
        sourceIdentity: "source",
        field: "voice",
        role: "voice",
        label: "Credited name",
        identityNamespace: "source.credit.voice",
        sourceKey: "Credited name",
      },
    ],
    entityResolutionDecisions: [
      {
        id: "resolution",
        mentionId: "mention",
        entityId: "persona",
        rule: "source-field-role-exact" as const,
        sourceRecordIds: ["record"],
      },
    ],
  };
  const proposal = {
    id: "proposal",
    basis: { kind: "source-interpretation" as const, interpretation },
    ruleResults: [
      {
        capabilityId: "recognizer",
        capabilityVersion: "1",
        ruleId: "exact",
        ruleVersion: "1",
        outcome: "satisfied" as const,
        explanation: "exact",
        evidence: [],
      },
    ],
  };
  return {
    proposal,
    entity: { id: "asset", kind: "digital-asset" },
    recognitionSourceAssociation: {
      id: "association",
      subjectId: "asset",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      proposalId: "proposal",
    },
    sourceAssociations: [
      {
        id: "association",
        subjectId: "asset",
        sourceIdentity: "source",
        nativeAddress: "https://source.example/work",
        proposalId: "proposal",
      },
    ],
    recognitionDecision: {
      id: "decision",
      proposalId: "proposal",
      assetId: "asset",
      acceptedRuleResults: proposal.ruleResults,
    },
    artifacts: [{ id: "artifact" }],
    locations: [
      {
        id: "location",
        artifactId: "artifact",
        address: "/managed/blob",
        kind: "managed",
      },
    ],
    blobs: [{ digest: "digest", mediaType: "image/jpeg", byteLength: 4 }],
    artifactRevisions: [
      { id: "revision", artifactId: "artifact", blobDigest: "digest" },
    ],
    artifactAssociations: [
      {
        id: "artifact-association",
        target: { kind: "entity", entityId: "asset" },
        artifactId: "artifact",
        role: "asset.primary-cover",
      },
    ],
    metadata: interpretation.metadata.map((assertion) => ({
      ...assertion,
      target: { kind: "entity" as const, entityId: "asset" },
    })),
    entities: [
      {
        id: "persona",
        kind: "persona",
        sourceIdentity: "source",
        sourceKey: "credited-name",
        identityNamespace: "source.credit.voice",
        label: "Credited name",
        sourceRecordIds: ["record"],
      },
    ],
    entityMentions: interpretation.entityMentions,
    entityResolutionDecisions: interpretation.entityResolutionDecisions,
    relationships: [
      {
        id: "relationship",
        participants: [
          { entityId: "asset", role: "asset" },
          { entityId: "persona", role: "voice" },
        ],
        type: "asset.contribution",
        sourceSlot: "source.credit.voice",
        sourceRecordIds: ["record"],
        qualifiers: [{ key: "credit-note", value: "official" }],
      },
    ],
  };
}

function acceptedExecution(): WorkflowExecution {
  return {
    ...execution(),
    status: "completed",
    stage: "completed",
    outcome: "accepted",
    acceptedAssetId: "asset",
    proposalId: "proposal",
  };
}

function acceptedExecutionFor(
  executionId: string,
  assetId: string,
): WorkflowExecution {
  return {
    ...executionFor(executionId),
    status: "completed",
    stage: "completed",
    outcome: "accepted",
    acceptedAssetId: assetId,
    proposalId: `proposal-${assetId}`,
    sourceRecordIds: [`record-${assetId}`],
  };
}

function executionFor(id: string): WorkflowExecution {
  return {
    ...execution(),
    id,
    snapshot: { ...execution().snapshot!, id: `snapshot-${id}` },
  };
}

function sourceRecordFor(assetId: string): SourceRecord {
  return {
    ...sourceRecord(),
    id: `record-${assetId}`,
    nativeAddress: `https://source.example/work/${assetId}`,
    acquisition: {
      ...sourceRecord().acquisition,
      requestedAddress: `https://source.example/work/${assetId}.json`,
    },
  };
}

function acceptedFor(
  assetId: string,
  sourceRecordId: string,
): AcceptedRecognition {
  const base = accepted();
  const proposalId = `proposal-${assetId}`;
  const associationId = `association-${assetId}`;
  const decisionId = `decision-${assetId}`;
  const artifactId = `artifact-${assetId}`;
  return {
    ...base,
    proposal: {
      ...base.proposal,
      id: proposalId,
      basis: {
        kind: "source-interpretation",
        interpretation: {
          ...base.proposal.basis.interpretation,
          id: `interpretation-${assetId}`,
          sourceRecordIds: [sourceRecordId],
          sourceAddress: `https://source.example/work/${assetId}`,
          metadata: base.proposal.basis.interpretation.metadata.map(
            (metadata) => ({ ...metadata, sourceRecordIds: [sourceRecordId] }),
          ),
          entities: base.proposal.basis.interpretation.entities?.map(
            (entity) => ({
              ...entity,
              id: `${entity.id}-${assetId}`,
              sourceKey: `${entity.sourceKey}-${assetId}`,
              sourceRecordIds: [sourceRecordId],
            }),
          ),
          entityMentions:
            base.proposal.basis.interpretation.entityMentions?.map(
              (mention) => ({
                ...mention,
                id: `${mention.id}-${assetId}`,
                sourceKey: `${mention.sourceKey}-${assetId}`,
                sourceRecordIds: [sourceRecordId],
              }),
            ),
          entityResolutionDecisions:
            base.proposal.basis.interpretation.entityResolutionDecisions?.map(
              (decision) => ({
                ...decision,
                id: `${decision.id}-${assetId}`,
                mentionId: `${decision.mentionId}-${assetId}`,
                entityId: `${decision.entityId}-${assetId}`,
                sourceRecordIds: [sourceRecordId],
              }),
            ),
        },
      },
    },
    entity: { id: assetId, kind: "digital-asset" },
    recognitionSourceAssociation: {
      ...base.recognitionSourceAssociation,
      id: associationId,
      subjectId: assetId,
      nativeAddress: `https://source.example/work/${assetId}`,
      proposalId,
    },
    sourceAssociations: [
      {
        ...base.recognitionSourceAssociation!,
        id: associationId,
        subjectId: assetId,
        nativeAddress: `https://source.example/work/${assetId}`,
        proposalId,
      },
    ],
    recognitionDecision: {
      ...base.recognitionDecision,
      id: decisionId,
      proposalId,
      assetId,
    },
    artifacts: [{ id: artifactId }],
    locations: base.locations.map((location) => ({
      ...location,
      id: `${location.id}-${assetId}`,
      artifactId,
    })),
    artifactRevisions: base.artifactRevisions.map((revision) => ({
      ...revision,
      id: `${revision.id}-${assetId}`,
      artifactId,
    })),
    artifactAssociations: base.artifactAssociations.map((association) => ({
      ...association,
      id: `${association.id}-${assetId}`,
      target: { kind: "entity" as const, entityId: assetId },
      artifactId,
    })),
    metadata: base.metadata.map((metadata) => ({
      ...metadata,
      target: { kind: "entity" as const, entityId: assetId },
      sourceRecordIds: [sourceRecordId],
    })),
    entities: base.entities.map((entity) => ({
      ...entity,
      id: `${entity.id}-${assetId}`,
      sourceKey: `${entity.sourceKey}-${assetId}`,
      sourceRecordIds: [sourceRecordId],
    })),
    entityMentions: base.entityMentions?.map((mention) => ({
      ...mention,
      id: `${mention.id}-${assetId}`,
      sourceKey: `${mention.sourceKey}-${assetId}`,
      sourceRecordIds: [sourceRecordId],
    })),
    entityResolutionDecisions: base.entityResolutionDecisions?.map(
      (decision) => ({
        ...decision,
        id: `${decision.id}-${assetId}`,
        mentionId: `${decision.mentionId}-${assetId}`,
        entityId: `${decision.entityId}-${assetId}`,
        sourceRecordIds: [sourceRecordId],
      }),
    ),
    relationships: base.relationships.map((relationship) => ({
      ...relationship,
      id: `${relationship.id}-${assetId}`,
      participants: relationship.participants.map((participant) => ({
        ...participant,
        entityId:
          participant.entityId === "asset"
            ? assetId
            : `${participant.entityId}-${assetId}`,
      })),
      sourceRecordIds: [sourceRecordId],
    })),
  };
}

function attentionPreview(executionId: string): ChangeImpactPreview {
  return {
    id: "attention-preview",
    executionId,
    assetId: "asset",
    proposal: accepted().proposal,
    baselines: [],
    current: {
      recognitionSourceAssociation: {
        sourceIdentity: "source",
        nativeAddress: "https://source.example/current",
      },
      sourceAssociations: [
        {
          sourceIdentity: "source",
          nativeAddress: "https://source.example/current",
        },
      ],
      metadata: [],
      entities: [],
      entityMentions: [],
      entityResolutionDecisions: [],
      relationships: [],
      artifacts: [],
      locations: [],
      blobs: [],
      artifactRevisions: [],
      artifactAssociations: [],
    },
    projected: {
      recognitionSourceAssociation: {
        sourceIdentity: "source",
        nativeAddress: "https://source.example/projected",
      },
      sourceAssociations: [
        {
          sourceIdentity: "source",
          nativeAddress: "https://source.example/projected",
        },
      ],
      metadata: [],
      entities: [],
      entityMentions: [],
      entityResolutionDecisions: [],
      relationships: [],
      artifacts: [],
      locations: [],
      blobs: [],
      artifactRevisions: [],
      artifactAssociations: [],
    },
    blockingConditions: [],
    status: "awaiting-confirmation",
  };
}

function changeImpactApplyInput(
  preview: ChangeImpactPreview,
): Parameters<SqliteCatalogue["applyChangeImpactPreview"]>[0] {
  const successorDecision = {
    id: `recognition-decision-${preview.id}`,
    proposalId: preview.proposal.id,
    assetId: preview.assetId,
    acceptedRuleResults: preview.proposal.ruleResults,
  };
  const projectedAssociation = preview.projected.recognitionSourceAssociation;
  return {
    preview,
    plan: {
      successorDecision,
      supersession: {
        id: `recognition-decision-supersession-${preview.id}`,
        predecessorDecisionId:
          preview.baselines.find(
            (baseline) => baseline.key === "recognition-decision",
          )?.value ?? "",
        successorDecisionId: successorDecision.id,
      },
      ...(projectedAssociation === undefined
        ? {}
        : {
            recognitionSourceAssociation: {
              id: `source-association-${preview.id}`,
              subjectId: preview.assetId,
              sourceIdentity: projectedAssociation.sourceIdentity,
              nativeAddress: projectedAssociation.nativeAddress,
              proposalId: preview.proposal.id,
            },
          }),
    },
  };
}

async function saveCurrentAttentionPreview(
  catalogue: SqliteCatalogue,
  input: {
    readonly executionId: string;
    readonly previewId: string;
    readonly accepted: AcceptedRecognition;
  },
): Promise<void> {
  const completeBaseline = await catalogue.freezeChangeImpactBaseline({
    assetId: input.accepted.entity.id,
    recognitionSourceAssociationId:
      input.accepted.recognitionSourceAssociation.id,
    recognitionDecisionId: input.accepted.recognitionDecision.id,
  });
  await catalogue.createExecution({
    ...executionFor(input.executionId),
    status: "completed",
    stage: "completed",
    outcome: "proposal",
  });
  await catalogue.saveChangeImpactPreview({
    ...attentionPreview(input.executionId),
    id: input.previewId,
    assetId: input.accepted.entity.id,
    baselines: [
      {
        key: "source-association",
        value: input.accepted.recognitionSourceAssociation.id,
      },
      {
        key: "recognition-decision",
        value: input.accepted.recognitionDecision.id,
      },
      {
        key: "source-records",
        value: input.accepted.proposal.basis.interpretation.sourceRecordIds
          .toSorted()
          .join(","),
      },
      { key: "complete-current-projection", value: completeBaseline },
    ],
  });
}

type DirectAcceptanceInput = Omit<
  Parameters<SqliteCatalogue["acceptRecognition"]>[0],
  "expectedExecution"
>;

async function acceptRecognition(
  catalogue: SqliteCatalogue,
  input: DirectAcceptanceInput,
): Promise<void> {
  const expectedExecution = (
    await catalogue.inspectExecution(input.execution.id)
  )?.execution;
  if (expectedExecution === undefined) {
    throw new Error(
      `Cannot accept without a durable execution baseline: ${input.execution.id}`,
    );
  }
  await catalogue.acceptRecognition({ ...input, expectedExecution });
}

function recoveryWorkflow(
  catalogue: SqliteCatalogue,
  options?: {
    readonly includeFormatFacts?: boolean;
    readonly collectorCapabilityVersion?: string;
    readonly collectionCalls?: { count: number };
    /**
     * 领域运行业务权威的测试接缝，可模拟应用层检查与取消写入之间的恢复所有者交接。
     */
    readonly sourceRefreshRuns?: Pick<
      SourceRefreshRunPersistence,
      "inspectSourceRefreshRun"
    >;
    /**
     * 仅恢复命令刻意与公开领域运行取消分离。在应用层拥有它之前，保持结构化契约。
     */
    readonly recoverySourceRefreshRuns?: RecoverySourceRefreshRunCommands;
    /** 供应用层所有的冻结不透明配置检查使用的测试接缝。 */
    readonly configurationCompatibility?: WorkflowConfigurationCompatibility;
    /** 使应用层租约请求时间与 SQLite 测试时钟对齐。 */
    readonly resumeClock?: AutomationClock;
    readonly observationBarrier?: Promise<void>;
    readonly onObservationStarted?: () => void;
    readonly observedDirectories?: string[];
    readonly collectionBarrier?: Promise<void>;
    readonly onCollectionStarted?: () => void;
    readonly uniqueRecordIds?: boolean;
    readonly uniqueProposalIds?: boolean;
    readonly acquisitionBarrier?: Promise<void>;
    readonly onAcquisitionStarted?: () => void;
    /** 使用已注册测试能力，同时保留此 SQLite 来源夹具。 */
    readonly filesystemOptions?: InMemoryObservedFilesystemOptions;
    readonly observedRootRegistrations?: Pick<
      ObservedRootRegistrations,
      | "resolveActiveScope"
      | "rebindFrozenScope"
      | "assertFrozenRootsCurrent"
      | "capability"
      | "objectIdentityContract"
      | "observeBoundScope"
      | "openBoundByteSource"
      | "closeBoundScope"
      | "reportCleanupFailure"
    >;
  },
): AssetRefreshWorkflow & AssetRefreshAutomationWorkflow {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  let collectionSequence = 0;
  let proposalSequence = 0;
  const capability = (capabilityId: string) => ({
    capabilityId,
    capabilityVersion:
      capabilityId === "recovery.collector"
        ? (options?.collectorCapabilityVersion ?? "1")
        : "1",
    contractVersion: "1",
  });
  const configurationCompatibility: WorkflowConfigurationCompatibility =
    options?.configurationCompatibility ?? {
      async checkCompatibility() {
        return { compatible: true };
      },
    };
  const registrations =
    options?.observedRootRegistrations ??
    inMemoryObservedRootRegistrations({
      capability: capability("recovery.observer"),
      async observe({ scope }) {
        const directory = scope.logicalLocation;
        options?.onObservationStarted?.();
        options?.observedDirectories?.push(directory);
        await options?.observationBarrier;
        return {
          id: "recovery-snapshot",
          root: directory,
          complete: true,
          excluded: [],
          files:
            options?.includeFormatFacts === true
              ? [
                  {
                    relativePath: "recovery-container.bin",
                    size: 12,
                    modifiedAt: "2026-07-29T00:00:00.000Z",
                  },
                ]
              : [],
          observedAt: "2026-07-29T00:00:00.000Z",
        };
      },
      ...options?.filesystemOptions,
    });
  const workflow = new AssetRefreshWorkflow({
    observedRootRegistrations: registrations,
    directoryInterpreters:
      options?.includeFormatFacts === true
        ? []
        : [
            {
              capability: capability("recovery.directory"),
              interpret: () => [
                {
                  kind: "source-address",
                  sourceIdentity: "recovery-source",
                  sourceAddress: "opaque:recovery-work",
                  explanation: "exact recovery evidence",
                  producer: capability("recovery.directory"),
                },
              ],
            },
          ],
    formatInspectors:
      options?.includeFormatFacts === true
        ? [
            {
              capability: capability("recovery.format-inspector"),
              inspect: ({ observedArtifactReference }) => [
                {
                  kind: "source-address",
                  sourceIdentity: "recovery-source",
                  sourceAddress: "opaque:recovery-work",
                  explanation: "exact recovery format evidence",
                  producer: capability("recovery.format-inspector"),
                  inspection: {
                    identifiers: [],
                    observedArtifactReference,
                    revision: {
                      digest: "recovery-format-parent-digest",
                      mediaType: "application/x-recovery-container",
                      byteLength: 12,
                    },
                    metadata: [
                      {
                        property: "asset.title",
                        sourceSlot: "recovery.format.title",
                        value: "Recovery local title",
                        locator: "recovery:format:title",
                      },
                    ],
                    parts: [],
                    entityGraph: {
                      observedArtifactReference,
                      producer: capability("recovery.format-inspector"),
                      coverage: {
                        id: "recovery.format.complete",
                        completeness: "complete",
                      },
                      entities: [
                        {
                          key: "local-contributor",
                          occurrenceSlot: "recovery.format.contributor",
                          label: "Recovery local contributor",
                          preservedValue: "Recovery local contributor",
                          locator: "recovery:format:contributor",
                        },
                      ],
                      mentions: [],
                      resolutions: [],
                      relationships: [],
                    },
                  },
                },
              ],
            },
          ]
        : [],
    collectors: [
      {
        capability: capability("recovery.collector"),
        canCollect: (evidence) => evidence.sourceIdentity === "recovery-source",
        coverageScopeIds: () => ["recovery.complete"],
        async collect() {
          collectionSequence += 1;
          const sourceRecordId = options?.uniqueRecordIds
            ? `recovery-record-${collectionSequence}`
            : "recovery-record";
          if (options?.collectionCalls !== undefined)
            options.collectionCalls.count += 1;
          options?.onCollectionStarted?.();
          await options?.collectionBarrier;
          return {
            failures: [],
            records: [
              {
                id: sourceRecordId,
                sourceIdentity: "recovery-source",
                nativeAddress: "opaque:recovery-work",
                mediaType: "application/json",
                acquiredAt: "2026-07-29T00:00:00.000Z",
                acquisition: {
                  requestedAddress: "https://source.example/recovery",
                  method: "GET",
                  authorized: false,
                },
                coverage: {
                  id: "recovery.complete",
                  completeness: "complete",
                  authority: "official",
                },
                digest: "recovery-record-digest",
                body: "{}",
              },
            ],
          };
        },
      },
    ],
    sourceInterpreters: [
      {
        capability: capability("recovery.interpreter"),
        canInterpret: ({ sourceRecords }) => sourceRecords.length === 1,
        interpret: ({ sourceRecords }) => [
          {
            id: "recovery-interpretation",
            producer: capability("recovery.interpreter"),
            sourceRecordIds: [sourceRecords[0].id],
            sourceIdentity: "recovery-source",
            sourceAddress: "opaque:recovery-work",
            metadata: [
              {
                property: "asset.title",
                sourceSlot: "recovery.title",
                value: "Recovery work",
                sourceRecordIds: [sourceRecords[0].id],
              },
            ],
            sourceArtifacts: [
              {
                id: "recovery-cover-candidate",
                sourceRecordId: sourceRecords[0].id,
                role: "asset.primary-cover",
                acquisitionReference: "opaque:recovery-cover",
                mediaType: "image/jpeg",
              },
            ],
          },
        ],
      },
    ],
    recognizers: [
      {
        capability: capability("recovery.recognizer"),
        canRecognize: ({ basis }) => basis.kind === "source-interpretation",
        recognize: ({ evidence }) => ({
          id: options?.uniqueProposalIds
            ? `recovery-proposal-${++proposalSequence}`
            : "recovery-proposal",
          ruleResults: [
            {
              capabilityId: "recovery.recognizer",
              capabilityVersion: "1",
              ruleId: "exact",
              ruleVersion: "1",
              outcome: "satisfied",
              explanation: "exact",
              evidence,
            },
          ],
        }),
      },
    ],
    recognitionPolicy: {
      version: "recovery-policy/1",
      accepts: (result) => result.ruleId === "exact",
    },
    acquirers: [
      {
        capability: capability("recovery.acquirer"),
        canAcquire: () => true,
        async acquire(candidate) {
          options?.onAcquisitionStarted?.();
          await options?.acquisitionBarrier;
          return {
            candidateId: candidate.id,
            sourceRecordId: candidate.sourceRecordId,
            bytes: jpeg,
            mediaType: "image/jpeg",
          };
        },
      },
    ],
    managedStore: {
      async stage(content) {
        return {
          candidateId: content.candidateId,
          sourceRecordId: content.sourceRecordId,
          role: content.role,
          stagedReference: `staged:${content.idempotencyKey}`,
          digest: sha256(content.bytes),
          mediaType: content.mediaType,
        };
      },
      async storeStaged(checkpoint) {
        return {
          blob: {
            digest: checkpoint.digest,
            mediaType: checkpoint.mediaType,
            byteLength: jpeg.byteLength,
          },
          location: { address: "/managed/recovery-cover" },
        };
      },
      async store(content) {
        return {
          blob: {
            digest: sha256(content.bytes),
            mediaType: content.mediaType,
            byteLength: content.bytes.byteLength,
          },
          location: { address: "/managed/recovery-cover" },
        };
      },
    },
    executionCommands: catalogue,
    executionQueries: catalogue,
    recoveryLease: catalogue,
    reuseQueries: catalogue,
    recognitionAcceptance: catalogue,
    recognitionReevaluation: catalogue,
    recognitionChangeImpact: catalogue,
    metadataRefreshPersistence: catalogue,
    ...(options?.sourceRefreshRuns === undefined
      ? {}
      : {
          sourceRefreshRuns:
            options.sourceRefreshRuns as SourceRefreshRunPersistence,
        }),
    ...(options?.recoverySourceRefreshRuns === undefined
      ? {}
      : {
          recoverySourceRefreshRuns: options.recoverySourceRefreshRuns,
        }),
    configurationCompatibility,
    changeImpactQueries: catalogue,
    changeImpactCommands: catalogue,
    ...(options?.resumeClock === undefined
      ? {}
      : { resumeClock: options.resumeClock }),
  });
  // 此辅助方法的默认观察根刻意采用内存应用层夹具，而非持久授权记录。生产和授权测试
  // 会传入真正的注册服务，并改为运行 `SqliteCatalogue` 可感知根的原子命令。
  const automationCommands =
    options?.observedRootRegistrations === undefined
      ? {
          async createAutomationIntentForObservedRoot(input: {
            readonly intent: import("@digital/application").AutomationIntent;
          }) {
            await catalogue.createAutomationIntentForTesting(input.intent);
            return { status: "created" as const };
          },
          releaseAutomationTrigger:
            catalogue.releaseAutomationTrigger.bind(catalogue),
          setAutomationIntentEnabled:
            catalogue.setAutomationIntentEnabled.bind(catalogue),
        }
      : catalogue;
  return attachAssetRefreshAutomation(
    workflow,
    new AssetRefreshAutomation(workflow, {
      executionQueries: catalogue,
      automationQueries: catalogue,
      automationCommands,
      observedRootRegistrations: registrations,
      recognitionPolicyVersion: "recovery-policy/1",
    }),
  );
}

/**
 * 创建真实 SQLite 父执行和一个非终态领域运行，再刻意让父执行缺少带版本的重放封装。
 * 未知输入必须中断恢复，但绝不能授权先前恢复所有者在租约被替换后更改该运行。
 */
async function createInterruptedRecoverySourceRefreshRun(
  catalogue: SqliteCatalogue,
  phase: "acquiring" | "applying" | "reviewing",
): Promise<{ readonly executionId: string; readonly runId: string }> {
  const seedId = `recovery-run-seed:${phase}`;
  const seed = { ...execution(), id: seedId };
  const seedAccepted = sourceRunSeedAccepted();
  await catalogue.createExecution(seed);
  await retainSourceRecords(catalogue, seedId, [sourceRecord()]);
  const seeded = await executionBaseline(catalogue, seedId);
  await acceptRecognition(catalogue, {
    execution: {
      ...seeded,
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      proposalId: seedAccepted.proposal.id,
      acceptedAssetId: seedAccepted.entity.id,
    },
    accepted: seedAccepted,
  });

  const executionId = `interrupted-source-refresh-parent:${phase}`;
  const runId = `interrupted-source-refresh-run:${phase}`;
  await catalogue.createExecution({
    ...execution(),
    id: executionId,
    selection: { intent: "metadata-refresh" },
    stage: "source-records-retained",
    compatibility: {
      workflowVersion: "asset-refresh/2",
      policyVersion: "recovery-policy/1",
      capabilityCoordinates: ["recovery.observer@1/1"],
    },
    dispositions: [],
  });
  const coverage = {
    sourceIdentity: "source",
    nativeAddress: "https://source.example/work",
    coverageId: "complete",
  };
  await catalogue.createSourceRefreshRun({
    executionId,
    run: {
      id: runId,
      initiatedBy: "recovery-test",
      initiatedAt: "2026-08-02T00:00:00.000Z",
      requestedSelection: {
        subjectId: seedAccepted.entity.id,
        sourceAssociationId: seedAccepted.recognitionSourceAssociation.id,
        sourceIdentity: coverage.sourceIdentity,
        nativeAddress: coverage.nativeAddress,
        selectors: [{ kind: "metadata-property", property: "asset.title" }],
      },
      reviewPolicy: phase === "reviewing" ? "review" : "automatic",
      baselineLineageHeads: [{ ...coverage, sourceRecordId: "record" }],
    },
  });
  await catalogue.beginSourceRefreshScopeAcquisition({ runId, coverage });
  if (phase === "acquiring") return { executionId, runId };

  const candidate = {
    ...sourceRecord(),
    id: `interrupted-source-refresh-candidate:${phase}`,
    acquiredAt: "2026-08-02T00:00:01.000Z",
    digest: `interrupted-source-refresh-digest:${phase}`,
  };
  await retainSourceRecords(catalogue, executionId, [candidate]);
  const initialInterpretation = seedAccepted.proposal.basis.interpretation;
  const staged = await catalogue.stageSourceRefreshChangeSet({
    runId,
    candidateSourceRecordId: candidate.id,
    interpretation: {
      ...initialInterpretation,
      id: `interrupted-source-refresh-interpretation:${phase}`,
      sourceRecordIds: [candidate.id],
      sourceIdentity: candidate.sourceIdentity,
      sourceAddress: candidate.nativeAddress,
      metadata: initialInterpretation.metadata.map((assertion) => ({
        ...assertion,
        sourceRecordIds: [candidate.id],
      })),
    },
  });
  if (phase === "applying") return { executionId, runId };
  expect(staged.phase).toBe("reviewing");
  return { executionId, runId };
}

/** 一条精确稳定的来源事实使应用夹具无需撤回。 */
function sourceRunSeedAccepted(): AcceptedRecognition {
  const base = accepted();
  const interpretation = {
    ...base.proposal.basis.interpretation,
    id: "source-run-seed-interpretation",
    metadata: base.proposal.basis.interpretation.metadata.map((assertion) => ({
      ...assertion,
      sourceRecordIds: ["record"],
    })),
    sourceArtifacts: [],
    entities: [],
    entityMentions: [],
    entityResolutionDecisions: [],
  };
  const proposal = {
    ...base.proposal,
    id: "source-run-seed-proposal",
    basis: { kind: "source-interpretation" as const, interpretation },
  };
  return {
    ...base,
    proposal,
    recognitionSourceAssociation: {
      ...base.recognitionSourceAssociation!,
      proposalId: proposal.id,
    },
    sourceAssociations: [
      { ...base.recognitionSourceAssociation!, proposalId: proposal.id },
    ],
    recognitionDecision: {
      ...base.recognitionDecision,
      proposalId: proposal.id,
    },
    artifacts: [],
    locations: [],
    blobs: [],
    artifactRevisions: [],
    artifactAssociations: [],
    metadata: interpretation.metadata.map((assertion) => ({
      ...assertion,
      target: { kind: "entity" as const, entityId: base.entity.id },
    })),
    entities: [],
    entityMentions: [],
    entityResolutionDecisions: [],
    relationships: [],
  };
}

/** 供公开来源丰富恢复路径使用的纯重启夹具。 */
function enrichmentCheckpointRecoveryWorkflow(
  catalogue: SqliteCatalogue,
  calls: Map<string, number>,
): AssetRefreshWorkflow {
  const capability = (capabilityId: string) => ({
    capabilityId,
    capabilityVersion: "1",
    contractVersion: "1",
  });
  const observedRootRegistrations = inMemoryObservedRootRegistrations({
    capability: capability("enrichment-recovery.observer"),
    async observe({ scope }) {
      const directory = scope.logicalLocation;
      return {
        id: "enrichment-recovery-snapshot",
        root: directory,
        complete: true,
        excluded: [],
        files: [],
        observedAt: "2026-07-31T00:00:00.000Z",
      };
    },
  });
  return new AssetRefreshWorkflow({
    observedRootRegistrations,
    directoryInterpreters: [],
    collectors: [
      {
        capability: capability("enrichment-recovery.collector"),
        canCollect: (evidence) =>
          evidence.sourceIdentity === "failed-recovery-source" ||
          evidence.sourceIdentity === "surviving-recovery-source",
        coverageScopeIds: () => ["enrichment-recovery.complete"],
        async collect(evidence) {
          calls.set(
            evidence.sourceIdentity,
            (calls.get(evidence.sourceIdentity) ?? 0) + 1,
          );
          if (evidence.sourceIdentity === "failed-recovery-source")
            throw new Error("failed enrichment must not be recollected");
          return {
            failures: [],
            records: [
              {
                id: "surviving-recovery-record",
                sourceIdentity: "surviving-recovery-source",
                nativeAddress: "surviving-recovery:work",
                mediaType: "application/json",
                acquiredAt: "2026-07-31T00:00:00.000Z",
                acquisition: {
                  requestedAddress: "surviving-recovery:work",
                  method: "GET" as const,
                  authorized: false,
                },
                coverage: {
                  id: "enrichment-recovery.complete",
                  completeness: "complete" as const,
                  authority: "official" as const,
                },
                digest: "surviving-recovery-digest",
                body: "{}",
              },
            ],
          };
        },
      },
    ],
    sourceInterpreters: [
      {
        capability: capability("enrichment-recovery.interpreter"),
        canInterpret: ({ evidence }) =>
          evidence.some(
            (item) => item.sourceIdentity === "surviving-recovery-source",
          ),
        interpret: () => [
          {
            id: "surviving-recovery-interpretation",
            producer: capability("enrichment-recovery.interpreter"),
            sourceRecordIds: ["surviving-recovery-record"],
            sourceIdentity: "surviving-recovery-source",
            sourceAddress: "surviving-recovery:work",
            metadata: [
              {
                property: "asset.awards",
                sourceSlot: "surviving-recovery.awards",
                value: "Recovered award",
                sourceRecordIds: ["surviving-recovery-record"],
              },
            ],
            sourceArtifacts: [],
          },
        ],
      },
    ],
    sourceAssociationCandidateInterpreters: [],
    sourceAssociationInterpreters: [
      {
        capability: capability("enrichment-recovery.association"),
        canInterpret: () => true,
        interpret: () => ({
          status: "accepted" as const,
          explanation: "exact surviving recovery identity",
        }),
      },
    ],
    recognizers: [],
    recognitionPolicy: {
      version: "enrichment-recovery-policy/1",
      accepts: () => false,
    },
    acquirers: [],
    managedStore: {
      async store() {
        throw new Error("recovery fixture requested no source artifacts");
      },
    },
    executionCommands: catalogue,
    executionQueries: catalogue,
    recoveryLease: catalogue,
    reuseQueries: catalogue,
    recognitionAcceptance: catalogue,
    recognitionReevaluation: catalogue,
    recognitionChangeImpact: catalogue,
    metadataRefreshPersistence: catalogue,
    sourceEnrichmentPersistence: catalogue,
    changeImpactQueries: catalogue,
    changeImpactCommands: catalogue,
    relationshipTraversalQueries: catalogue,
    relatedEntityIdentity: catalogue,
    relationshipDecisionPersistence: catalogue,
  });
}

function reevaluationWorkflow(
  catalogue: SqliteCatalogue,
  state: {
    observationVersion: number;
    sourceVersion: number;
    expanded: boolean;
    managedMissing: boolean;
    omitCover: boolean;
    explicitPlan?: boolean;
    sourceRefreshAuthority?: boolean;
    collectionBarrier?: () => Promise<void>;
    partialSourceRefreshFailure?: boolean;
    partialSourceRefreshRetry?: boolean;
    frozenCoverageIds?: string[][];
    stableSourceFacts?: boolean;
    /** 独立于已观察产物身份验证 `Blob` 去重。 */
    observedDigest?: string;
    /** 仅时间戳变化的对象仍可能再次观察到相同字节。 */
    stableObservedByteLength?: boolean;
    sourceResolvedSubject?: "root" | "alpha" | "beta";
    sourceSubjectDisplayName?: string;
    sourceSubjectAlias?: string;
    omitSourceSubjectRelationship?: boolean;
    metadataPolicyConfiguration?: MetadataPolicyConfiguration;
    reverseSourceResolvedSubjectQualifiers?: boolean;
    relatedMention?: boolean;
    personaKind?: "entity" | "person" | "persona";
    omitPersona?: boolean;
    sourceCompleteness?: "complete" | "incomplete";
    sourceAddress?: string;
    sourceRecordPrefix?: string;
  },
): AssetRefreshWorkflow {
  const capability = (capabilityId: string) => ({
    capabilityId,
    capabilityVersion: "1",
    contractVersion: "1",
  });
  const metadataRefreshPersistence: MetadataRefreshPersistence = {
    async freezeSourceLineageHeads(input) {
      state.frozenCoverageIds?.push([...input.coverageIds]);
      return await catalogue.freezeSourceLineageHeads(input);
    },
    async applyMetadataRefresh(input) {
      await catalogue.applyMetadataRefresh(input);
    },
  };
  const observedRootRegistrations = inMemoryObservedRootRegistrations({
    capability: capability("reevaluation.observer"),
    async observe({ scope }) {
      const directory = scope.logicalLocation;
      return {
        id: `reevaluation-snapshot-${state.observationVersion}`,
        root: directory,
        complete: true,
        excluded: [],
        observedAt: `2026-07-30T00:00:0${state.observationVersion}.000Z`,
        files: [
          {
            relativePath: "work.bin",
            size: state.stableObservedByteLength
              ? 4
              : 4 + state.observationVersion,
            modifiedAt: `2026-07-30T00:00:0${state.observationVersion}.000Z`,
          },
        ],
      };
    },
  });
  return new AssetRefreshWorkflow({
    observedRootRegistrations,
    directoryInterpreters:
      state.observedDigest === undefined
        ? [
            {
              capability: capability("reevaluation.directory"),
              interpret: () => {
                const evidence = {
                  kind: "source-address" as const,
                  sourceIdentity: "reevaluation-source",
                  sourceAddress:
                    state.sourceAddress ?? "opaque:reevaluation-work",
                  explanation: "exact",
                  producer: capability("reevaluation.directory"),
                };
                return state.explicitPlan === false
                  ? [evidence]
                  : {
                      workItems: [
                        {
                          key: "work",
                          relativePaths: ["work.bin"],
                          evidence: [evidence],
                        },
                      ],
                    };
              },
            },
          ]
        : [],
    formatInspectors:
      state.observedDigest === undefined
        ? []
        : [
            {
              capability: capability("reevaluation.format-inspector"),
              inspect: ({ observedArtifactReference }) => [
                {
                  kind: "source-address" as const,
                  sourceIdentity: "reevaluation-source",
                  sourceAddress:
                    state.sourceAddress ?? "opaque:reevaluation-work",
                  explanation: "same source identity from observed format",
                  producer: capability("reevaluation.format-inspector"),
                  inspection: {
                    identifiers: [],
                    observedArtifactReference,
                    revision: {
                      digest: state.observedDigest,
                      mediaType: "application/octet-stream",
                      byteLength: 4,
                    },
                    metadata: [],
                    parts: [],
                  },
                },
              ],
            },
          ],
    collectors: [
      {
        capability: capability("reevaluation.collector"),
        canCollect: () => true,
        coverageScopeIds: () =>
          state.partialSourceRefreshFailure === true ||
          state.partialSourceRefreshRetry === true
            ? ["reevaluation.title", "reevaluation.description"]
            : ["reevaluation.complete"],
        async collect() {
          await state.collectionBarrier?.();
          state.sourceVersion += 1;
          const recordId = `${state.sourceRecordPrefix ?? "reevaluation-record"}-${state.sourceVersion}`;
          const coverageId =
            state.partialSourceRefreshFailure === true
              ? "reevaluation.title"
              : state.partialSourceRefreshRetry === true
                ? "reevaluation.description"
                : "reevaluation.complete";
          return {
            failures: state.partialSourceRefreshFailure
              ? [
                  {
                    capability: capability("reevaluation.collector"),
                    reason: "description endpoint failed",
                    coverage: {
                      sourceIdentity: "reevaluation-source",
                      nativeAddress:
                        state.sourceAddress ?? "opaque:reevaluation-work",
                      coverageId: "reevaluation.description",
                    },
                  },
                ]
              : [],
            records: [
              {
                id: recordId,
                sourceIdentity: "reevaluation-source",
                nativeAddress:
                  state.sourceAddress ?? "opaque:reevaluation-work",
                mediaType: "application/json",
                acquiredAt: `2026-07-30T00:00:${String(state.sourceVersion).padStart(2, "0")}.000Z`,
                acquisition: {
                  requestedAddress: "https://source.example/reevaluation",
                  method: "GET" as const,
                  authorized: false,
                },
                coverage: {
                  id: coverageId,
                  completeness:
                    state.sourceCompleteness ?? ("complete" as const),
                  authority: "official" as const,
                },
                digest: `reevaluation-record-digest-${state.sourceVersion}`,
                body: "{}",
              },
            ],
          };
        },
      },
    ],
    sourceInterpreters: [
      {
        capability: capability("reevaluation.interpreter"),
        relationshipDefinitions: [
          {
            id: "fixture.contribution",
            type: "asset.contribution",
            label: "测试署名",
            roles: [{ role: "asset", label: "作品", minimum: 1 }],
            additionalRoles: { label: "署名角色" },
            qualifiers: [],
          },
          {
            id: "fixture.association",
            type: "entity.association",
            label: "测试关联",
            roles: [],
            additionalRoles: { label: "角色" },
            qualifiers: [
              { key: "kind", label: "含义" },
              { key: "scope", label: "范围" },
            ],
          },
          {
            id: "fixture.membership-three",
            type: "asset.membership",
            label: "测试三方关系",
            roles: [
              { role: "series", label: "系列", minimum: 1 },
              { role: "member", label: "成员", minimum: 1 },
              { role: "performer", label: "表演者", minimum: 1 },
            ],
            qualifiers: [{ key: "asset.membership.position", label: "顺序" }],
          },
          {
            id: "fixture.membership",
            type: "asset.membership",
            label: "测试成员关系",
            roles: [
              { role: "series", label: "系列", minimum: 0 },
              { role: "member", label: "成员", minimum: 1 },
              { role: "performer", label: "表演者", minimum: 0 },
            ],
            qualifiers: [{ key: "asset.membership.position", label: "顺序" }],
          },
          ...["reference", "context"].map((suffix) => ({
            id: `fixture.identity-${suffix}`,
            type: `identity.${suffix}`,
            label: "测试身份引用",
            roles: [
              { role: "subject", label: "主体", minimum: 1 },
              { role: "context", label: "上下文", minimum: 1 },
            ],
            qualifiers: [],
          })),
          {
            id: "fixture.identity-ambiguous",
            type: "identity.ambiguous",
            label: "测试同角色参与",
            roles: [{ role: "subject", label: "主体", minimum: 2 }],
            qualifiers: [],
          },
        ],
        canInterpret: ({ sourceRecords }) => sourceRecords.length === 1,
        interpret: ({ sourceRecords }) => {
          const recordId = sourceRecords[0].id;
          const sourceResolvedSubject =
            state.sourceResolvedSubject === "alpha" ||
            state.sourceResolvedSubject === "beta"
              ? {
                  id: `reevaluation-source-subject-${state.sourceResolvedSubject}`,
                  sourceKey: state.sourceResolvedSubject,
                  label: `Source subject ${state.sourceResolvedSubject}`,
                }
              : undefined;
          const sourceSubjectFactsEnabled =
            state.sourceResolvedSubject !== undefined;
          return [
            {
              id: `${state.sourceRecordPrefix ?? "reevaluation"}-interpretation-${state.sourceVersion}`,
              producer: capability("reevaluation.interpreter"),
              sourceRecordIds: [recordId],
              sourceIdentity: "reevaluation-source",
              sourceAddress: state.sourceAddress ?? "opaque:reevaluation-work",
              metadata: [
                {
                  property: "asset.title",
                  sourceSlot: "reevaluation.title",
                  value: state.stableSourceFacts
                    ? "Stable reevaluation title"
                    : `Reevaluation title ${state.sourceVersion}`,
                  sourceRecordIds: [recordId],
                },
                ...(state.expanded
                  ? [
                      {
                        property: "asset.summary",
                        sourceSlot: "reevaluation.summary",
                        value: "Expanded summary",
                        sourceRecordIds: [recordId],
                      },
                    ]
                  : []),
                ...(!sourceSubjectFactsEnabled
                  ? []
                  : [
                      {
                        ...(sourceResolvedSubject === undefined
                          ? {}
                          : { subjectId: sourceResolvedSubject.id }),
                        property: "entity.display-name",
                        sourceSlot: "reevaluation.source-subject.name",
                        value:
                          state.sourceSubjectDisplayName ??
                          "Stable sourced subject",
                        sourceRecordIds: [recordId],
                        qualifiers:
                          state.reverseSourceResolvedSubjectQualifiers === true
                            ? [
                                { key: "language", value: "en" },
                                { key: "script", value: "Latn" },
                              ]
                            : [
                                { key: "script", value: "Latn" },
                                { key: "language", value: "en" },
                              ],
                      },
                      ...(state.sourceSubjectAlias === undefined
                        ? []
                        : [
                            {
                              ...(sourceResolvedSubject === undefined
                                ? {}
                                : { subjectId: sourceResolvedSubject.id }),
                              property: "entity.alias",
                              sourceSlot: "reevaluation.source-subject.alias",
                              value: state.sourceSubjectAlias,
                              sourceRecordIds: [recordId],
                            },
                          ]),
                    ]),
              ],
              entities: [
                ...(state.omitPersona === true
                  ? []
                  : [
                      {
                        id: "reevaluation-persona",
                        kind: state.personaKind ?? ("persona" as const),
                        sourceIdentity: "reevaluation-source",
                        sourceKey: "persona",
                        identityNamespace: "reevaluation.persona",
                        label: "Stable persona",
                        sourceRecordIds: [recordId],
                      },
                    ]),
                ...(state.expanded
                  ? [
                      {
                        id: "reevaluation-editor",
                        kind: "persona" as const,
                        sourceIdentity: "reevaluation-source",
                        sourceKey: "editor",
                        identityNamespace: "reevaluation.persona",
                        label: "Expanded editor",
                        sourceRecordIds: [recordId],
                      },
                    ]
                  : []),
                ...(sourceResolvedSubject === undefined
                  ? []
                  : [
                      {
                        id: sourceResolvedSubject.id,
                        kind: "persona" as const,
                        sourceIdentity: "reevaluation-source",
                        sourceKey: sourceResolvedSubject.sourceKey,
                        identityNamespace: "reevaluation.source-subject",
                        label: sourceResolvedSubject.label,
                        sourceRecordIds: [recordId],
                      },
                    ]),
              ],
              relationships: [
                ...(state.omitPersona === true
                  ? []
                  : [
                      {
                        participants: [
                          {
                            entityId: "reevaluation-persona",
                            role: "voice",
                            ...(state.relatedMention === true
                              ? { mentionIds: ["reevaluation-voice-mention"] }
                              : {}),
                          },
                        ],
                        subjectRole: "asset",
                        type: "asset.contribution" as const,
                        sourceSlot: "reevaluation.credit.voice",
                        sourceRecordIds: [recordId],
                      },
                    ]),
                ...(state.expanded
                  ? [
                      {
                        participants: [
                          { entityId: "reevaluation-editor", role: "editing" },
                        ],
                        subjectRole: "asset",
                        type: "asset.contribution" as const,
                        sourceSlot: "reevaluation.credit.editing",
                        sourceRecordIds: [recordId],
                      },
                    ]
                  : []),
                ...(!sourceSubjectFactsEnabled ||
                state.omitSourceSubjectRelationship === true
                  ? []
                  : [
                      {
                        ...(sourceResolvedSubject === undefined
                          ? {
                              participants: [
                                {
                                  entityId: "reevaluation-persona",
                                  role: "related",
                                },
                              ],
                              subjectRole: "asset",
                            }
                          : {
                              participants: [
                                {
                                  entityId: sourceResolvedSubject.id,
                                  role: "source-subject",
                                },
                                {
                                  entityId: "reevaluation-persona",
                                  role: "related",
                                },
                              ],
                            }),
                        ...(sourceResolvedSubject === undefined
                          ? {}
                          : { sourceSubjectId: sourceResolvedSubject.id }),
                        type: "entity.association",
                        sourceSlot: "reevaluation.source-subject.association",
                        sourceRecordIds: [recordId],
                        qualifiers:
                          state.reverseSourceResolvedSubjectQualifiers === true
                            ? [
                                { key: "kind", value: "credit" },
                                { key: "scope", value: "source" },
                              ]
                            : [
                                { key: "scope", value: "source" },
                                { key: "kind", value: "credit" },
                              ],
                      },
                    ]),
              ],
              entityMentions:
                state.relatedMention === true
                  ? [
                      {
                        id: "reevaluation-voice-mention",
                        sourceRecordIds: [recordId],
                        sourceIdentity: "reevaluation-source",
                        field: "voice",
                        role: "voice",
                        label: "Stable persona",
                        identityNamespace: "reevaluation.persona",
                        sourceKey: "persona",
                      },
                    ]
                  : [],
              entityResolutionDecisions:
                state.relatedMention === true
                  ? [
                      {
                        id: `reevaluation-voice-resolution-${state.sourceVersion}`,
                        mentionId: "reevaluation-voice-mention",
                        entityId: "reevaluation-persona",
                        rule: "source-field-role-exact" as const,
                        sourceRecordIds: [recordId],
                      },
                    ]
                  : [],
              sourceArtifacts: state.omitCover
                ? []
                : [
                    {
                      id: "reevaluation-cover",
                      sourceRecordId: recordId,
                      role: "asset.primary-cover",
                      acquisitionReference: "opaque:reevaluation-cover",
                      mediaType: "image/jpeg",
                    },
                  ],
            },
          ];
        },
      },
    ],
    recognizers: [
      {
        capability: capability("reevaluation.recognizer"),
        canRecognize: ({ basis }) => basis.kind === "source-interpretation",
        recognize: ({ evidence }) => ({
          id: `${state.sourceRecordPrefix ?? "reevaluation"}-proposal-${state.sourceVersion}`,
          ruleResults: [
            {
              capabilityId: "reevaluation.recognizer",
              capabilityVersion: "1",
              ruleId: "exact",
              ruleVersion: "1",
              outcome: "satisfied",
              explanation: "exact",
              evidence,
            },
          ],
        }),
      },
    ],
    recognitionPolicy: {
      version: "reevaluation-policy/1",
      accepts: (result) => result.ruleId === "exact",
    },
    acquirers: [
      {
        capability: capability("reevaluation.acquirer"),
        canAcquire: () => true,
        async acquire(candidate) {
          return {
            candidateId: candidate.id,
            sourceRecordId: candidate.sourceRecordId,
            bytes: new Uint8Array([0xff, 0xd8, state.sourceVersion, 0xd9]),
            mediaType: "image/jpeg",
          };
        },
      },
    ],
    managedStore: {
      async stage(content) {
        return {
          candidateId: content.candidateId,
          sourceRecordId: content.sourceRecordId,
          role: content.role,
          stagedReference: `staged:${content.sourceRecordId}`,
          digest: sha256(content.bytes),
          mediaType: content.mediaType,
        };
      },
      async storeStaged(checkpoint) {
        return {
          blob: {
            digest: checkpoint.digest,
            mediaType: checkpoint.mediaType,
            byteLength: 4,
          },
          location: {
            address: `/managed/${checkpoint.sourceRecordId}/cover.jpg`,
          },
        };
      },
      async store(content) {
        return {
          blob: {
            digest: sha256(content.bytes),
            mediaType: content.mediaType,
            byteLength: content.bytes.byteLength,
          },
          location: {
            address: `/managed/reevaluation-record-${state.sourceVersion}/cover.jpg`,
          },
        };
      },
      async isAvailable() {
        return !state.managedMissing;
      },
    },
    executionCommands: catalogue,
    executionQueries: catalogue,
    recoveryLease: catalogue,
    reuseQueries: catalogue,
    recognitionAcceptance: catalogue,
    recognitionReevaluation: catalogue,
    recognitionChangeImpact: catalogue,
    metadataRefreshPersistence,
    ...(state.sourceRefreshAuthority === true
      ? {
          sourceRefreshRuns: catalogue,
          recoverySourceRefreshRuns: catalogue,
        }
      : {}),
    changeImpactQueries: catalogue,
    changeImpactCommands: catalogue,
    relationshipTraversalQueries: catalogue,
    metadataPolicyConfiguration: state.metadataPolicyConfiguration,
    relatedEntityIdentity: catalogue,
    relationshipDecisionPersistence: catalogue,
  });
}

function crossBasisObservedEntityGraph(
  observedArtifactReference: string,
  producer: {
    readonly capabilityId: string;
    readonly capabilityVersion: string;
    readonly contractVersion: string;
  },
  graph: "d1" | "d2" | "empty",
) {
  if (graph === "empty")
    return {
      observedArtifactReference,
      producer,
      coverage: { id: "cross-basis.graph", completeness: "complete" as const },
      entities: [],
      mentions: [],
      resolutions: [],
      relationships: [],
    };
  const label = graph === "d1" ? "Observed D1" : "Observed D2";
  return {
    observedArtifactReference,
    producer,
    coverage: { id: "cross-basis.graph", completeness: "complete" as const },
    entities: [
      {
        key: "contributor",
        occurrenceSlot: "cross-basis.contributor",
        label,
        preservedValue: label,
        locator: `cross-basis:${graph}:${observedArtifactReference}:contributor`,
      },
    ],
    mentions: [
      {
        key: "contributor-mention",
        entityKey: "contributor",
        sourceSlot: "cross-basis.contributor",
        field: "contributor",
        role: "author",
        label,
        locator: `cross-basis:${graph}:${observedArtifactReference}:contributor`,
      },
    ],
    resolutions: [
      { mentionKey: "contributor-mention", entityKey: "contributor" },
    ],
    relationships: [
      {
        sourceSlot: "cross-basis.contributor",
        type: "asset.contribution",
        subjectRole: "asset",
        participants: [
          {
            entityKey: "contributor",
            role: "author",
            mentionKeys: ["contributor-mention"],
          },
        ],
        qualifiers: [],
        locator: `cross-basis:${graph}:${observedArtifactReference}:contributor`,
      },
    ],
  };
}

function crossBasisReplacementWorkflow(
  catalogue: SqliteCatalogue,
  state: {
    basis: "observed-evidence" | "source-interpretation";
    observedGraph?: "d1" | "d2" | "empty";
    observedGeneration?: number;
    observedArtifactReferences?: readonly string[];
  },
): AssetRefreshWorkflow {
  const capability = (capabilityId: string) => ({
    capabilityId,
    capabilityVersion: "1",
    contractVersion: "1",
  });
  const observedRootRegistrations = inMemoryObservedRootRegistrations({
    capability: capability("cross-basis.observer"),
    async observe({ scope }) {
      return {
        id: `cross-basis-snapshot:${state.basis}:${state.observedGeneration ?? 1}`,
        root: scope.logicalLocation,
        complete: true,
        excluded: [],
        observedAt: "2026-08-30T00:00:00.000Z",
        files: (state.observedArtifactReferences ?? ["work.bin"]).map(
          (relativePath) => ({
            relativePath,
            size: 4,
            modifiedAt: `2026-08-30T00:00:0${state.observedGeneration ?? 1}.000Z`,
          }),
        ),
      };
    },
  });
  return new AssetRefreshWorkflow({
    observedRootRegistrations,
    directoryInterpreters: [
      {
        capability: capability("cross-basis.directory"),
        interpret: () => {
          if (state.basis === "source-interpretation")
            return [
              {
                kind: "source-address" as const,
                sourceIdentity: "cross-basis-source",
                sourceAddress: "opaque:cross-basis-work",
                explanation: "精确来源地址",
                producer: capability("cross-basis.directory"),
              },
            ];
          if ((state.observedArtifactReferences?.length ?? 0) > 1)
            return {
              workItems: [
                {
                  key: "cross-basis-observed-bundle",
                  relativePaths: state.observedArtifactReferences!,
                  evidence: [],
                },
              ],
            };
          return [];
        },
      },
    ],
    formatInspectors: [
      {
        capability: capability("cross-basis.inspector"),
        relationshipDefinitions: [
          {
            id: "cross-basis.contribution",
            type: "asset.contribution",
            label: "测试署名",
            roles: [
              { role: "asset", label: "作品", minimum: 1, maximum: 1 },
              { role: "author", label: "作者", minimum: 1 },
            ],
            qualifiers: [],
          },
        ],
        inspect: ({ observedArtifactReference }) =>
          state.basis === "observed-evidence"
            ? [
                {
                  kind: "format.valid-publication" as const,
                  explanation: "精确观察到的有效作品",
                  producer: capability("cross-basis.inspector"),
                  inspection: {
                    identifiers: [],
                    observedArtifactReference,
                    revision: {
                      digest: `cross-basis-observed-digest-${state.observedGeneration ?? 1}-${observedArtifactReference}`,
                      mediaType: "application/octet-stream",
                      byteLength: 4,
                    },
                    metadata: [],
                    parts: [],
                    ...(state.observedGraph === undefined
                      ? {}
                      : {
                          entityGraph: crossBasisObservedEntityGraph(
                            observedArtifactReference,
                            capability("cross-basis.inspector"),
                            state.observedGraph,
                          ),
                        }),
                  },
                },
              ]
            : [],
      },
    ],
    collectors: [
      {
        capability: capability("cross-basis.collector"),
        canCollect: (evidence) =>
          evidence.sourceIdentity === "cross-basis-source" ||
          evidence.sourceIdentity === "cross-basis-supplement",
        coverageScopeIds: (evidence) => [
          evidence.sourceIdentity === "cross-basis-supplement"
            ? "cross-basis-supplement.complete"
            : "cross-basis.complete",
        ],
        async collect(evidence) {
          const supplement =
            evidence.sourceIdentity === "cross-basis-supplement";
          return {
            failures: [],
            records: [
              {
                id: supplement
                  ? "cross-basis-supplement-record"
                  : "cross-basis-record",
                sourceIdentity: supplement
                  ? "cross-basis-supplement"
                  : "cross-basis-source",
                nativeAddress: supplement
                  ? "opaque:cross-basis-supplement"
                  : "opaque:cross-basis-work",
                mediaType: "application/json",
                acquiredAt: "2026-08-30T00:00:00.000Z",
                acquisition: {
                  requestedAddress: "https://source.example/cross-basis",
                  method: "GET" as const,
                  authorized: false,
                },
                coverage: {
                  id: supplement
                    ? "cross-basis-supplement.complete"
                    : "cross-basis.complete",
                  completeness: "complete" as const,
                  authority: "official" as const,
                },
                digest: supplement
                  ? "cross-basis-supplement-record-digest"
                  : "cross-basis-record-digest",
                body: "{}",
              },
            ],
          };
        },
      },
    ],
    sourceInterpreters: [
      {
        capability: capability("cross-basis.interpreter"),
        canInterpret: ({ sourceRecords }) =>
          sourceRecords.length === 1 &&
          sourceRecords[0]?.sourceIdentity === "cross-basis-source",
        interpret: ({ sourceRecords }) => [
          {
            id: "cross-basis-interpretation",
            producer: capability("cross-basis.interpreter"),
            sourceRecordIds: [sourceRecords[0].id],
            sourceIdentity: "cross-basis-source",
            sourceAddress: "opaque:cross-basis-work",
            metadata: [
              {
                property: "asset.title",
                sourceSlot: "cross-basis.source.title",
                value: "Source work",
                sourceRecordIds: [sourceRecords[0].id],
              },
            ],
            sourceArtifacts: [],
          },
        ],
      },
      {
        capability: capability("cross-basis.supplement-interpreter"),
        canInterpret: ({ sourceRecords }) =>
          sourceRecords.length === 1 &&
          sourceRecords[0]?.sourceIdentity === "cross-basis-supplement",
        interpret: ({ sourceRecords }) => [
          {
            id: "cross-basis-supplement-interpretation",
            producer: capability("cross-basis.supplement-interpreter"),
            sourceRecordIds: [sourceRecords[0].id],
            sourceIdentity: "cross-basis-supplement",
            sourceAddress: "opaque:cross-basis-supplement",
            metadata: [
              {
                property: "asset.awards",
                sourceSlot: "cross-basis.supplement.awards",
                value: "Supplement award",
                sourceRecordIds: [sourceRecords[0].id],
              },
            ],
            sourceArtifacts: [],
          },
        ],
      },
    ],
    recognizers: [
      {
        capability: capability("cross-basis.recognizer"),
        canRecognize: () => true,
        recognize: ({ evidence }) => ({
          id: `cross-basis-proposal:${state.basis}:${state.observedGeneration ?? 1}`,
          ruleResults: [
            {
              capabilityId: "cross-basis.recognizer",
              capabilityVersion: "1",
              ruleId: `exact-${state.basis}`,
              ruleVersion: "1",
              outcome: "satisfied" as const,
              explanation: "精确依据",
              evidence,
            },
          ],
        }),
      },
    ],
    recognitionPolicy: {
      version: "cross-basis-policy/1",
      accepts: () => true,
    },
    acquirers: [],
    managedStore: {
      async store() {
        throw new Error("跨依据夹具没有来源产物");
      },
    },
    executionCommands: catalogue,
    executionQueries: catalogue,
    recoveryLease: catalogue,
    reuseQueries: catalogue,
    recognitionAcceptance: catalogue,
    recognitionReevaluation: catalogue,
    recognitionChangeImpact: catalogue,
    metadataRefreshPersistence: catalogue,
    sourceAssociationCandidateInterpreters: [
      {
        capability: capability("cross-basis.supplement-candidate"),
        interpret: () => ({
          kind: "source-association" as const,
          explanation: "精确补充来源",
          sourceIdentity: "cross-basis-supplement",
          sourceAddress: "opaque:cross-basis-supplement",
          producer: capability("cross-basis.supplement-candidate"),
        }),
      },
    ],
    sourceAssociationInterpreters: [
      {
        capability: capability("cross-basis.supplement-association"),
        canInterpret: () => true,
        interpret: () => ({
          status: "accepted" as const,
          explanation: "精确补充来源身份",
        }),
      },
    ],
    sourceEnrichmentPersistence: catalogue,
    changeImpactQueries: catalogue,
    changeImpactCommands: catalogue,
    relationshipTraversalQueries: catalogue,
    relatedEntityIdentity: catalogue,
    relationshipDecisionPersistence: catalogue,
  });
}

it("replaces recognition basis in both directions through a reopened Application and SQLite boundary", async () => {
  async function replaceBasis(
    predecessor: "observed-evidence" | "source-interpretation",
    successor: "observed-evidence" | "source-interpretation",
  ) {
    const informationRequirement = {
      metadataUsageContext: "asset.ordinary" as const,
      metadata: [{ property: "asset.awards", necessity: "optional" as const }],
      artifactRoles: [],
      relationshipTypes: [],
    };
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = { basis: predecessor };
    const workflow = crossBasisReplacementWorkflow(catalogue, state);
    const initial = await workflow.scanObservedScope({
      registrationId: "/observed/cross-basis",
      relativeScope: ".",
      executionId: `cross-basis-initial:${predecessor}`,
      acceptTrusted: true,
      informationRequirement,
    });
    expect(initial.execution.outcome, JSON.stringify(initial.execution)).toBe(
      "accepted",
    );
    const initialInspection = (await catalogue.inspectExecution(
      initial.execution.id,
    ))!;
    const before =
      initialInspection.accepted ??
      initialInspection.workItemInspections?.[0]?.accepted;
    expect(before).toBeDefined();
    expect(before!.proposal.basis.kind).toBe(predecessor);
    expect(before!.sourceAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIdentity: "cross-basis-supplement",
          nativeAddress: "opaque:cross-basis-supplement",
        }),
      ]),
    );
    expect(before!.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "Supplement award" }),
      ]),
    );

    state.basis = successor;
    const proposed = await workflow.scanObservedScope({
      registrationId: "/observed/cross-basis",
      relativeScope: ".",
      executionId: `cross-basis-replacement:${predecessor}:${successor}`,
      acceptTrusted: true,
      informationRequirement,
    });
    expect(proposed.execution.outcome, JSON.stringify(proposed.execution)).toBe(
      "proposal",
    );
    const preview = await catalogue.inspectChangeImpactPreviewForExecution(
      proposed.execution.id,
    );
    expect(preview?.proposal.observedEntityGraphs ?? []).toHaveLength(0);
    expect(preview?.status).toBe("awaiting-confirmation");
    expect(preview?.proposal.basis.kind).toBe(successor);
    if (preview?.proposal.basis.kind === "source-interpretation")
      expect(preview.proposal.basis.interpretation.sourceRecordIds).toEqual([
        "cross-basis-record",
      ]);
    expect(preview?.projected.recognitionSourceAssociation).toEqual(
      successor === "source-interpretation"
        ? {
            sourceIdentity: "cross-basis-source",
            nativeAddress: "opaque:cross-basis-work",
          }
        : undefined,
    );
    const expectedProjectedSourceAssociations = [
      {
        sourceIdentity: "cross-basis-supplement",
        nativeAddress: "opaque:cross-basis-supplement",
      },
      ...(successor === "source-interpretation"
        ? [
            {
              sourceIdentity: "cross-basis-source",
              nativeAddress: "opaque:cross-basis-work",
            },
          ]
        : []),
    ];
    const expectedProjectedMetadata = [
      expect.objectContaining({ value: "Supplement award" }),
      ...(successor === "source-interpretation"
        ? [expect.objectContaining({ value: "Source work" })]
        : []),
    ];
    expect(preview?.projected.sourceAssociations).toEqual(
      expectedProjectedSourceAssociations,
    );
    expect(preview?.projected.metadata).toEqual(expectedProjectedMetadata);
    await expect(
      workflow.inspectChangeImpactPreview(preview!.id),
    ).resolves.toMatchObject({
      projected: { sourceAssociations: expectedProjectedSourceAssociations },
    });
    const beforeConfirmation = await catalogue.findAcceptedForDirectory(
      "/observed/cross-basis",
    );
    expect(beforeConfirmation?.accepted.proposal.basis.kind).toBe(predecessor);
    const stalePreviewId = `${preview!.id}:stale-sibling`;
    await catalogue.saveChangeImpactPreview({
      ...preview!,
      id: stalePreviewId,
    });

    catalogue.close();
    const reopened = SqliteCatalogue.forProductData(root);
    const resumed = crossBasisReplacementWorkflow(reopened, state);
    if (predecessor === "source-interpretation") {
      const rollbackGuard = new DatabaseSync(
        path.join(root, "catalogue.sqlite"),
      );
      rollbackGuard.exec(`CREATE TRIGGER fail_cross_basis_completion
        BEFORE UPDATE ON change_impact_previews
        WHEN NEW.id = '${preview!.id.replaceAll("'", "''")}'
          AND json_extract(NEW.preview_json, '$.status') = 'applied'
        BEGIN
          SELECT RAISE(ABORT, 'forced cross-basis completion failure');
        END`);
      rollbackGuard.close();
      await expect(
        resumed.applyChangeImpactPreview({
          previewId: preview!.id,
          confirmedBy: "cross-basis-reviewer",
        }),
      ).rejects.toThrow();
      await expect(
        reopened.findAcceptedForDirectory("/observed/cross-basis"),
      ).resolves.toMatchObject({
        accepted: { proposal: { basis: { kind: predecessor } } },
      });
      await expect(
        reopened.inspectChangeImpactPreview(preview!.id),
      ).resolves.toMatchObject({ status: "awaiting-confirmation" });
      const removeRollbackGuard = new DatabaseSync(
        path.join(root, "catalogue.sqlite"),
      );
      removeRollbackGuard.exec("DROP TRIGGER fail_cross_basis_completion");
      removeRollbackGuard.close();
    }
    await expect(
      resumed.applyChangeImpactPreview({
        previewId: preview!.id,
        confirmedBy: "cross-basis-reviewer",
      }),
    ).resolves.toMatchObject({ status: "applied" });
    const after = await reopened.findAcceptedForDirectory(
      "/observed/cross-basis",
    );
    expect(after?.accepted).toMatchObject({
      proposal: { basis: { kind: successor } },
      sourceAssociations: expectedProjectedSourceAssociations,
      metadata: expectedProjectedMetadata,
    });
    expect(after?.accepted.recognitionSourceAssociation).toEqual(
      successor === "source-interpretation"
        ? expect.objectContaining({
            sourceIdentity: "cross-basis-source",
            nativeAddress: "opaque:cross-basis-work",
          })
        : undefined,
    );
    expect(after?.accepted.sourceAssociations).toEqual(
      expectedProjectedSourceAssociations.map((association) =>
        expect.objectContaining(association),
      ),
    );
    expect(after?.accepted.metadata).toEqual(expectedProjectedMetadata);
    expect(after?.accepted.recognitionDecision.id).not.toBe(
      before!.recognitionDecision.id,
    );
    await expect(
      reopened.inspectChangeImpactPreview(stalePreviewId),
    ).resolves.toMatchObject({ status: "stale" });
    const durableHistory = new DatabaseSync(
      path.join(root, "catalogue.sqlite"),
    );
    expect(
      durableHistory
        .prepare(
          `SELECT recognition_source_association_id AS associationId,
                  recognition_decision_id AS decisionId
           FROM recognition_heads WHERE subject_id = ?`,
        )
        .get(before!.entity.id),
    ).toEqual({
      associationId:
        successor === "source-interpretation"
          ? after!.accepted.recognitionSourceAssociation!.id
          : null,
      decisionId: after!.accepted.recognitionDecision.id,
    });
    expect(
      durableHistory
        .prepare(
          `SELECT 1 FROM recognition_decision_supersessions
           WHERE predecessor_decision_id = ? AND successor_decision_id = ?`,
        )
        .get(
          before!.recognitionDecision.id,
          after!.accepted.recognitionDecision.id,
        ),
    ).toBeDefined();
    expect(
      durableHistory
        .prepare(
          `SELECT 1 FROM source_associations
           WHERE subject_id = ? AND source_identity = ? AND native_address = ?`,
        )
        .get(
          before!.entity.id,
          "cross-basis-supplement",
          "opaque:cross-basis-supplement",
        ),
    ).toBeDefined();
    expect(
      durableHistory
        .prepare(
          `SELECT 1 FROM metadata_assertions
           WHERE subject_id = ? AND value = ? AND source_record_ids_json <> '[]'`,
        )
        .get(before!.entity.id, "Supplement award"),
    ).toBeDefined();
    durableHistory.close();
    if (predecessor === "source-interpretation") {
      expect(after?.accepted.metadata).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "Source work" }),
        ]),
      );
      const history = new DatabaseSync(path.join(root, "catalogue.sqlite"));
      expect(
        history
          .prepare(
            `SELECT 1 FROM metadata_assertions
             WHERE value = ? AND source_record_ids_json <> '[]'`,
          )
          .get("Source work"),
      ).toBeDefined();
      history.close();
    }
    reopened.close();
  }

  await replaceBasis("observed-evidence", "source-interpretation");
  await replaceBasis("source-interpretation", "observed-evidence");
});

it("adopts only the successor's complete observed graph after SQLite reopen", async () => {
  const informationRequirement = {
    metadataUsageContext: "asset.ordinary" as const,
    metadata: [],
    artifactRoles: [],
    relationshipTypes: [],
  };
  async function replaceObservedGraph(successor: "d2" | "empty") {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      basis: "observed-evidence" as const,
      observedGraph: "d1" as const,
      observedGeneration: 1,
    };
    const workflow = crossBasisReplacementWorkflow(catalogue, state);
    const initial = await workflow.scanObservedScope({
      registrationId: "/observed/cross-basis",
      relativeScope: ".",
      executionId: `cross-basis-graph-initial:${successor}`,
      acceptTrusted: true,
      informationRequirement,
    });
    expect(initial.execution.outcome).toBe("accepted");
    const before = await catalogue.findAcceptedForDirectory(
      "/observed/cross-basis",
    );
    expect(before?.accepted.observedEntityGraphs).toEqual([
      expect.objectContaining({
        entities: [expect.objectContaining({ label: "Observed D1" })],
      }),
    ]);
    const observedD1 = (await workflow.findRelatedEntities("Observed D1"))[0]!;
    const automaticD1 = (await workflow.inspectCurrentCatalogueEntity(
      observedD1.id,
    ))!.relationships.find(({ type }) => type === "asset.contribution")!;
    const excludeD1 = await workflow.previewRelationshipChange({
      changes: [{ kind: "exclude", relationshipIds: [automaticD1.id] }],
    });
    await expect(
      workflow.applyRelationshipChange({
        actorId: "user:甲",
        preview: excludeD1,
      }),
    ).resolves.toBe("applied");
    await expect(
      workflow.inspectCurrentCatalogueEntity(observedD1.id),
    ).resolves.toMatchObject({ relationships: [] });

    state.observedGeneration = 2;
    state.observedGraph = successor;
    const proposed = await workflow.scanObservedScope({
      registrationId: "/observed/cross-basis",
      relativeScope: ".",
      executionId: `cross-basis-graph-successor:${successor}`,
      acceptTrusted: true,
      informationRequirement,
    });
    expect(proposed.execution.outcome).toBe("proposal");
    const preview = await catalogue.inspectChangeImpactPreviewForExecution(
      proposed.execution.id,
    );
    expect(preview?.projectedObservedEntityGraphs).toEqual([
      expect.objectContaining({
        entities:
          successor === "empty"
            ? []
            : [expect.objectContaining({ label: "Observed D2" })],
      }),
    ]);
    await expect(
      catalogue.findAcceptedForDirectory("/observed/cross-basis"),
    ).resolves.toMatchObject({
      accepted: {
        observedEntityGraphs: [
          expect.objectContaining({
            entities: [expect.objectContaining({ label: "Observed D1" })],
          }),
        ],
      },
    });

    const stalePreview = {
      ...preview!,
      id: `${preview!.id}:stale`,
      baselines: preview!.baselines.map((baseline) =>
        baseline.key === "recognition-decision"
          ? { ...baseline, value: "not-the-current-decision" }
          : baseline,
      ),
    };
    await catalogue.saveChangeImpactPreview(stalePreview);
    await expect(
      workflow.applyChangeImpactPreview({
        previewId: stalePreview.id,
        confirmedBy: "cross-basis-graph-reviewer",
      }),
    ).resolves.toMatchObject({ status: "stale" });
    await expect(
      catalogue.findAcceptedForDirectory("/observed/cross-basis"),
    ).resolves.toMatchObject({
      accepted: {
        observedEntityGraphs: [
          expect.objectContaining({
            entities: [expect.objectContaining({ label: "Observed D1" })],
          }),
        ],
      },
    });

    if (successor === "d2") {
      const failureGuard = new DatabaseSync(
        path.join(root, "catalogue.sqlite"),
      );
      failureGuard.exec(`CREATE TRIGGER fail_observed_graph_successor
        BEFORE UPDATE ON change_impact_previews
        WHEN NEW.id = '${preview!.id.replaceAll("'", "''")}'
          AND json_extract(NEW.preview_json, '$.status') = 'applied'
        BEGIN
          SELECT RAISE(ABORT, 'forced observed graph successor failure');
        END`);
      failureGuard.close();
      await expect(
        workflow.applyChangeImpactPreview({
          previewId: preview!.id,
          confirmedBy: "cross-basis-graph-reviewer",
        }),
      ).rejects.toThrow();
      await expect(
        catalogue.findAcceptedForDirectory("/observed/cross-basis"),
      ).resolves.toMatchObject({
        accepted: {
          observedEntityGraphs: [
            expect.objectContaining({
              entities: [expect.objectContaining({ label: "Observed D1" })],
            }),
          ],
        },
      });
      const removeFailureGuard = new DatabaseSync(
        path.join(root, "catalogue.sqlite"),
      );
      removeFailureGuard.exec("DROP TRIGGER fail_observed_graph_successor");
      removeFailureGuard.close();
    }

    catalogue.close();
    const reopened = SqliteCatalogue.forProductData(root);
    const resumed = crossBasisReplacementWorkflow(reopened, state);
    await expect(
      resumed.applyChangeImpactPreview({
        previewId: preview!.id,
        confirmedBy: "cross-basis-graph-reviewer",
      }),
    ).resolves.toMatchObject({ status: "applied" });
    const after = await reopened.findAcceptedForDirectory(
      "/observed/cross-basis",
    );
    expect(after?.accepted.observedEntityGraphs).toEqual([
      expect.objectContaining({
        entities:
          successor === "empty"
            ? []
            : [expect.objectContaining({ label: "Observed D2" })],
      }),
    ]);
    expect(after?.accepted.recognitionDecision.id).not.toBe(
      before?.accepted.recognitionDecision.id,
    );
    await expect(
      resumed.previewRelationshipChange({
        changes: [{ kind: "clear", relationshipIds: [automaticD1.id] }],
      }),
    ).rejects.toThrow("关系决定必须点名当前关系");
    await expect(resumed.findRelatedEntities("Observed D1")).resolves.toEqual(
      [],
    );
    if (successor === "d2") {
      const observedD2 = (await resumed.findRelatedEntities("Observed D2"))[0]!;
      await expect(
        resumed.inspectCurrentCatalogueEntity(observedD2.id),
      ).resolves.toMatchObject({
        relationships: [
          expect.objectContaining({ type: "asset.contribution" }),
        ],
      });
    }
    reopened.close();
  }

  await replaceObservedGraph("d2");
  await replaceObservedGraph("empty");
});

it("公开观察身份只在当前图中参与查找、合并与关系查询", async () => {
  const informationRequirement = {
    metadataUsageContext: "asset.ordinary" as const,
    metadata: [],
    artifactRoles: [],
    relationshipTypes: [],
  };
  const { catalogue } = await createCatalogueWithRoot();
  const state = {
    basis: "observed-evidence" as const,
    observedGraph: "d1" as const,
    observedGeneration: 1,
  };
  const workflow = crossBasisReplacementWorkflow(catalogue, state);
  const initial = await workflow.scanObservedScope({
    registrationId: "/observed/cross-basis",
    relativeScope: ".",
    executionId: "current-observed-identity-initial",
    acceptTrusted: true,
    informationRequirement,
  });
  expect(initial.execution.outcome).toBe("accepted");

  const observedD1 = await workflow.findRelatedEntities("Observed D1");
  expect(observedD1).toEqual([
    expect.objectContaining({ label: "Observed D1", identity: "local" }),
  ]);
  const d1 = observedD1[0]!;
  await expect(
    workflow.inspectCurrentCatalogueEntity(d1.id),
  ).resolves.toMatchObject({
    relationships: [expect.objectContaining({ type: "asset.contribution" })],
  });
  const retained = await workflow.createLocalRelatedEntity({
    commitmentId: "current-observed-identity/retained",
    label: "Current observed retained",
    kind: "entity",
    actorId: "user:甲",
  });
  const merge = await workflow.previewEntityIdentityMerge({
    retainedEntityId: retained.id,
    mergedEntityId: d1.id,
  });
  await expect(
    workflow.applyEntityIdentityMerge({
      commitmentId: "current-observed-identity/merge",
      actorId: "user:甲",
      preview: merge,
    }),
  ).resolves.toBe("applied");

  state.observedGraph = "d2";
  state.observedGeneration = 2;
  const successor = await workflow.scanObservedScope({
    registrationId: "/observed/cross-basis",
    relativeScope: ".",
    executionId: "current-observed-identity-successor",
    acceptTrusted: true,
    informationRequirement,
  });
  const successorPreview =
    await catalogue.inspectChangeImpactPreviewForExecution(
      successor.execution.id,
    );
  await expect(
    workflow.applyChangeImpactPreview({
      previewId: successorPreview!.id,
      confirmedBy: "user:甲",
    }),
  ).resolves.toMatchObject({ status: "applied" });
  // 已采用的同一合并仍可按原提交重放，并可定位后撤销；这不让旧 D1 标签重回 find。
  await expect(
    workflow.applyEntityIdentityMerge({
      commitmentId: "current-observed-identity/merge",
      actorId: "user:甲",
      preview: merge,
    }),
  ).resolves.toBe("applied");
  const undo = await workflow.previewEntityIdentityMerge({
    retainedEntityId: retained.id,
    mergedEntityId: d1.id,
  });
  await expect(
    workflow.undoEntityIdentityMerge({
      commitmentId: "current-observed-identity/undo",
      actorId: "user:甲",
      preview: undo,
    }),
  ).resolves.toBe("applied");
  await expect(
    workflow.inspectCurrentCatalogueEntity(d1.id),
  ).resolves.toBeUndefined();
  await expect(workflow.findRelatedEntities("Observed D1")).resolves.toEqual(
    [],
  );
  catalogue.close();

  for (const successorGraph of ["d2", "empty"] as const) {
    const historical = await createCatalogueWithRoot();
    const historicalState = {
      basis: "observed-evidence" as const,
      observedGraph: "d1" as const,
      observedGeneration: 1,
    };
    const historicalWorkflow = crossBasisReplacementWorkflow(
      historical.catalogue,
      historicalState,
    );
    await historicalWorkflow.scanObservedScope({
      registrationId: "/observed/cross-basis",
      relativeScope: ".",
      executionId: `historical-observed-identity-initial:${successorGraph}`,
      acceptTrusted: true,
      informationRequirement,
    });
    const historicalD1 = (
      await historicalWorkflow.findRelatedEntities("Observed D1")
    )[0]!;
    const persistentCandidate =
      await historicalWorkflow.createLocalRelatedEntity({
        commitmentId: `historical-observed-identity/candidate:${successorGraph}`,
        label: `Current candidate ${successorGraph}`,
        kind: "entity",
        actorId: "user:甲",
      });
    const staleNewMerge = await historicalWorkflow.previewEntityIdentityMerge({
      retainedEntityId: persistentCandidate.id,
      mergedEntityId: historicalD1.id,
    });

    historicalState.observedGraph = successorGraph;
    historicalState.observedGeneration = 2;
    const replacement = await historicalWorkflow.scanObservedScope({
      registrationId: "/observed/cross-basis",
      relativeScope: ".",
      executionId: `historical-observed-identity-successor:${successorGraph}`,
      acceptTrusted: true,
      informationRequirement,
    });
    const replacementPreview =
      await historical.catalogue.inspectChangeImpactPreviewForExecution(
        replacement.execution.id,
      );
    historical.catalogue.close();

    const historicalReopened = SqliteCatalogue.forProductData(historical.root);
    const historicalReopenedWorkflow = crossBasisReplacementWorkflow(
      historicalReopened,
      historicalState,
    );
    await historicalReopenedWorkflow.applyChangeImpactPreview({
      previewId: replacementPreview!.id,
      confirmedBy: "user:甲",
    });
    await expect(
      historicalReopenedWorkflow.findRelatedEntities("Observed D1"),
    ).resolves.toEqual([]);
    await expect(
      historicalReopenedWorkflow.inspectCurrentCatalogueEntity(historicalD1.id),
    ).resolves.toBeUndefined();
    await expect(
      historicalReopenedWorkflow.previewEntityIdentityMerge({
        retainedEntityId: persistentCandidate.id,
        mergedEntityId: historicalD1.id,
      }),
    ).rejects.toThrow("待合并相关实体不是当前身份");
    await expect(
      historicalReopenedWorkflow.applyEntityIdentityMerge({
        commitmentId: `historical-observed-identity/merge:${successorGraph}`,
        actorId: "user:甲",
        preview: staleNewMerge,
      }),
    ).rejects.toThrow("待合并相关实体不是当前身份");
    if (successorGraph === "d2") {
      const observedD2 =
        await historicalReopenedWorkflow.findRelatedEntities("Observed D2");
      expect(observedD2).toEqual([
        expect.objectContaining({ label: "Observed D2", identity: "local" }),
      ]);
      await expect(
        historicalReopenedWorkflow.inspectCurrentCatalogueEntity(
          observedD2[0]!.id,
        ),
      ).resolves.toMatchObject({
        relationships: [
          expect.objectContaining({ type: "asset.contribution" }),
        ],
      });
    }
    historicalReopened.close();
  }
});

it("keeps each observed graph support with its own artifact revision after reopen", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const state = {
    basis: "observed-evidence" as const,
    observedGraph: "d1" as const,
    observedGeneration: 1,
    observedArtifactReferences: ["left.bin", "right.bin"],
  };
  const workflow = crossBasisReplacementWorkflow(catalogue, state);
  const scanned = await workflow.scanObservedScope({
    registrationId: "/observed/cross-basis",
    relativeScope: ".",
    executionId: "cross-basis-two-observed-artifacts",
    acceptTrusted: true,
    informationRequirement: {
      metadataUsageContext: "asset.ordinary",
      metadata: [],
      artifactRoles: [],
      relationshipTypes: [],
    },
  });
  expect(scanned.execution.outcome).toBe("accepted");
  const assertSeparateArtifactRevisions = async (
    currentCatalogue: SqliteCatalogue,
  ) => {
    const accepted = await currentCatalogue.findAcceptedForDirectory(
      "/observed/cross-basis",
    );
    const graphs = accepted?.accepted.observedEntityGraphs;
    expect(graphs).toHaveLength(2);
    expect(new Set(graphs?.map((graph) => graph.artifactId)).size).toBe(2);
    expect(new Set(graphs?.map((graph) => graph.revisionId)).size).toBe(2);
    expect(graphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entities: [
            expect.objectContaining({
              locator: "cross-basis:d1:left.bin:contributor",
            }),
          ],
        }),
        expect.objectContaining({
          entities: [
            expect.objectContaining({
              locator: "cross-basis:d1:right.bin:contributor",
            }),
          ],
        }),
      ]),
    );
  };
  await assertSeparateArtifactRevisions(catalogue);
  catalogue.close();

  const reopened = SqliteCatalogue.forProductData(root);
  await assertSeparateArtifactRevisions(reopened);
  reopened.close();
});

it("keeps one observed artifact's revision graph members isolated after reopen", async () => {
  const { root, catalogue } = await createCatalogueWithRoot();
  const base = accepted();
  const graph = (revisionId: string, label: string) => {
    const entityId = `observed-${label.toLowerCase()}`;
    const mentionId = `${entityId}-mention`;
    const relationshipId = `${entityId}-relationship`;
    return {
      assetId: base.entity.id,
      artifactId: "artifact",
      revisionId,
      producer: {
        capabilityId: "revision-isolation.inspector",
        capabilityVersion: "1",
        contractVersion: "1",
      },
      coverageId: "revision-isolation.graph",
      complete: true as const,
      entities: [
        {
          id: entityId,
          occurrenceSlot: "revision-isolation.contributor",
          label,
          preservedValue: label,
          locator: `revision-isolation:${revisionId}:${label}`,
        },
      ],
      mentions: [
        {
          id: mentionId,
          entityId,
          sourceSlot: "revision-isolation.contributor",
          field: "contributor",
          role: "author",
          label,
          locator: `revision-isolation:${revisionId}:${label}`,
        },
      ],
      resolutions: [{ mentionId, entityId }],
      relationships: [
        {
          id: relationshipId,
          participants: [
            { entityId: base.entity.id, role: "asset" },
            { entityId, role: "author", mentionIds: [mentionId] },
          ],
          type: "asset.contribution",
          sourceSlot: "revision-isolation.contributor",
          sourceRecordIds: [],
          producer: {
            capabilityId: "revision-isolation.inspector",
            capabilityVersion: "1",
            contractVersion: "1",
          },
          qualifiers: [],
        },
      ],
    };
  };
  const revisionOne = graph("revision", "Alice");
  const revisionTwo = graph("revision-two", "Bob");
  await catalogue.createExecution(execution());
  await retainSourceRecords(catalogue, "execution", [sourceRecord()]);
  await acceptRecognition(catalogue, {
    execution: acceptedExecution(),
    accepted: {
      ...base,
      blobs: [
        { digest: "digest", mediaType: "image/jpeg", byteLength: 4 },
        { digest: "digest-two", mediaType: "image/jpeg", byteLength: 4 },
      ],
      artifactRevisions: [
        { id: "revision", artifactId: "artifact", blobDigest: "digest" },
        {
          id: "revision-two",
          artifactId: "artifact",
          blobDigest: "digest-two",
        },
      ],
      observedEntityGraphs: [revisionOne, revisionTwo],
    },
  });

  const assertRevisionMembers = async (current: SqliteCatalogue) => {
    const found = await current.findAcceptedForSubjects(["asset"]);
    const graphs = found[0]?.accepted.observedEntityGraphs;
    expect(
      graphs
        ?.map((item) => ({
          revisionId: item.revisionId,
          labels: item.entities.map((entity) => entity.label),
          relationshipIds: item.relationships.map(
            (relationship) => relationship.id,
          ),
        }))
        .toSorted((left, right) =>
          left.revisionId.localeCompare(right.revisionId),
        ),
    ).toEqual([
      {
        revisionId: "revision",
        labels: ["Alice"],
        relationshipIds: ["observed-alice-relationship"],
      },
      {
        revisionId: "revision-two",
        labels: ["Bob"],
        relationshipIds: ["observed-bob-relationship"],
      },
    ]);
  };
  await assertRevisionMembers(catalogue);
  catalogue.close();

  const reopened = SqliteCatalogue.forProductData(root);
  await assertRevisionMembers(reopened);
  reopened.close();
});

function multiRecoveryWorkflow(
  catalogue: SqliteCatalogue,
  state: {
    generation: string;
    blockSecondStore: boolean;
    blockSecondProposal?: boolean;
    conflictingSecondCandidate?: boolean;
    releaseSecondStore?: () => void;
    releaseSecondProposal?: () => void;
    readonly counts: {
      directory: number;
      collect: number;
      interpret: number;
      recognize: number;
      acquire: number;
      storeSecond: number;
    };
  },
): AssetRefreshWorkflow {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const capability = (capabilityId: string) => ({
    capabilityId,
    capabilityVersion: "1",
    contractVersion: "1",
  });
  const collectSharedRecords = () => {
    state.counts.collect += 1;
    const productRecord = (key: "one" | "two") => ({
      id: `product-record-${key}-${state.generation}`,
      sourceIdentity: "multi",
      nativeAddress: `opaque:${key}`,
      mediaType: "application/json",
      acquiredAt: "2026-07-30T00:00:00.000Z",
      acquisition: {
        requestedAddress: `https://source.example/${key}`,
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: `digest-product-${key}-${state.generation}`,
      body: "{}",
    });
    const sharedCoverRecordId = `shared-cover-record-${state.generation}`;
    return {
      failures: [],
      records: [
        productRecord("one"),
        productRecord("two"),
        {
          id: sharedCoverRecordId,
          sourceIdentity: "multi",
          nativeAddress: "opaque:shared-cover",
          mediaType: "image/jpeg",
          acquiredAt: "2026-07-30T00:00:00.000Z",
          acquisition: {
            requestedAddress: "https://source.example/shared-cover",
            method: "GET" as const,
            authorized: false,
          },
          coverage: {
            id: "complete",
            completeness: "complete" as const,
            authority: "official" as const,
          },
          digest: `digest-${sharedCoverRecordId}`,
          body: "shared cover",
        },
      ],
    };
  };
  const persistence = Object.create(catalogue) as SqliteCatalogue;
  if (state.blockSecondProposal === true) {
    persistence.finishExecutionWithProposal = async (
      expectedExecution,
      execution,
      proposal,
      resumeClaim,
    ) => {
      await catalogue.finishExecutionWithProposal(
        expectedExecution,
        execution,
        proposal,
        resumeClaim,
      );
      if (
        proposal.basis.kind === "source-interpretation" &&
        proposal.basis.interpretation.sourceArtifacts.some((candidate) =>
          candidate.id.startsWith("two-attachment"),
        )
      ) {
        await new Promise<void>((resolve) => {
          state.releaseSecondProposal = resolve;
        });
      }
    };
  }
  const observedRootRegistrations = inMemoryObservedRootRegistrations({
    capability: capability("multi.observer"),
    async observe({ scope }) {
      const directory = scope.logicalLocation;
      return {
        id: "multi-snapshot",
        root: directory,
        complete: true,
        excluded: [],
        observedAt: "2026-07-30T00:00:00.000Z",
        files: [
          {
            relativePath: "one.bin",
            size: 1,
            modifiedAt: "2026-07-30T00:00:00.000Z",
          },
          {
            relativePath: "two.bin",
            size: 2,
            modifiedAt: "2026-07-30T00:00:00.000Z",
          },
        ],
      };
    },
  });
  return new AssetRefreshWorkflow({
    observedRootRegistrations,
    directoryInterpreters: [
      {
        capability: capability("multi.directory"),
        interpret: () => {
          state.counts.directory += 1;
          return {
            workItems: ["one", "two"].map((key) => ({
              key,
              relativePaths: [`${key}.bin`],
              evidence: [
                {
                  kind: "source-address" as const,
                  sourceIdentity: "multi",
                  sourceAddress: `opaque:${key}`,
                  explanation: key,
                  producer: capability("multi.directory"),
                },
              ],
            })),
          };
        },
      },
    ],
    collectors: [
      {
        capability: capability("multi.collector"),
        canCollect: () => true,
        coverageScopeIds: () => ["complete"],
        collectionScopeIds: () => ["shared-work"],
        async collect() {
          return collectSharedRecords();
        },
        async collectShared() {
          return collectSharedRecords();
        },
      },
    ],
    sourceInterpreters: [
      {
        capability: capability("multi.interpreter"),
        canInterpret: () => true,
        interpret: ({ sourceRecords, evidence }) => {
          state.counts.interpret += 1;
          const sourceAddress = evidence[0].sourceAddress!;
          const productRecords =
            sourceAddress === "opaque:query"
              ? sourceRecords.filter(
                  (record) =>
                    record.nativeAddress === "opaque:one" ||
                    record.nativeAddress === "opaque:two",
                )
              : sourceRecords.filter(
                  (record) => record.nativeAddress === sourceAddress,
                );
          const sharedCoverRecord = sourceRecords.find(
            (record) => record.nativeAddress === "opaque:shared-cover",
          );
          if (productRecords.length === 0 || sharedCoverRecord === undefined)
            throw new Error(
              "multi fixture requires product and shared cover records",
            );
          const sharedCoverRecordId = sharedCoverRecord.id;
          return productRecords.map((productRecord) => {
            const recordId = productRecord.id;
            const boundary = productRecord.nativeAddress.slice(-3);
            return {
              id: `interpretation-${randomUUID()}`,
              producer: capability("multi.interpreter"),
              sourceRecordIds: [recordId, sharedCoverRecordId],
              sourceIdentity: "multi",
              sourceAddress: productRecord.nativeAddress,
              metadata: [
                {
                  property: "asset.title",
                  sourceSlot: "multi.title",
                  value: boundary,
                  sourceRecordIds: [recordId],
                },
              ],
              sourceArtifacts: [
                {
                  id: `shared-cover-${sharedCoverRecordId}`,
                  sourceRecordId: sharedCoverRecordId,
                  subjectId: "shared-work",
                  role: "asset.primary-cover",
                  acquisitionReference:
                    state.conflictingSecondCandidate === true &&
                    boundary === "two"
                      ? "opaque:conflicting-cover"
                      : "opaque:shared-cover",
                  mediaType: "image/jpeg",
                },
                {
                  id: `${boundary}-attachment-${recordId}`,
                  sourceRecordId: recordId,
                  role: "asset.attachment",
                  acquisitionReference: `opaque:${boundary}-attachment`,
                  mediaType: "image/jpeg",
                },
              ],
              entities: [
                {
                  id: "shared-work",
                  kind: "entity" as const,
                  sourceIdentity: "multi",
                  sourceKey: "shared-work",
                  identityNamespace: "multi.work",
                  label: "Shared work",
                  sourceRecordIds: [recordId, sharedCoverRecordId],
                },
              ],
            };
          });
        },
      },
    ],
    recognizers: [
      {
        capability: capability("multi.recognizer"),
        canRecognize: () => true,
        recognize: ({ evidence }) => {
          state.counts.recognize += 1;
          return {
            id: `proposal-${randomUUID()}`,
            ruleResults: [
              {
                capabilityId: "multi.recognizer",
                capabilityVersion: "1",
                ruleId: "exact",
                ruleVersion: "1",
                outcome: "satisfied" as const,
                explanation: "exact",
                evidence,
              },
            ],
          };
        },
      },
    ],
    recognitionPolicy: {
      version: "multi-policy/1",
      accepts: (result) => result.ruleId === "exact",
    },
    acquirers: [
      {
        capability: capability("multi.acquirer"),
        canAcquire: () => true,
        async acquire(candidate) {
          state.counts.acquire += 1;
          return {
            candidateId: candidate.id,
            sourceRecordId: candidate.sourceRecordId,
            bytes,
            mediaType: "image/jpeg",
          };
        },
      },
    ],
    managedStore: {
      async store(content) {
        return {
          blob: {
            digest: sha256(content.bytes),
            mediaType: content.mediaType,
            byteLength: content.bytes.byteLength,
          },
          location: { address: "/managed/unused" },
        };
      },
      async stage(content) {
        return {
          candidateId: content.candidateId,
          sourceRecordId: content.sourceRecordId,
          role: content.role,
          stagedReference: `staged:${content.idempotencyKey}`,
          digest: sha256(content.bytes),
          mediaType: content.mediaType,
        };
      },
      async storeStaged(checkpoint) {
        if (
          checkpoint.candidateId.startsWith("two-attachment") &&
          state.blockSecondStore
        ) {
          await new Promise<void>((resolve) => {
            state.releaseSecondStore = resolve;
          });
        }
        if (checkpoint.candidateId.startsWith("two-attachment")) {
          state.counts.storeSecond += 1;
        }
        return {
          blob: {
            digest: checkpoint.digest,
            mediaType: checkpoint.mediaType,
            byteLength: bytes.byteLength,
          },
          location: { address: `/managed/${checkpoint.candidateId}` },
        };
      },
      async isAvailable() {
        return true;
      },
    },
    executionCommands: persistence,
    executionQueries: persistence,
    recoveryLease: persistence,
    reuseQueries: persistence,
    recognitionAcceptance: persistence,
    recognitionReevaluation: persistence,
    recognitionChangeImpact: persistence,
    metadataRefreshPersistence: persistence,
    sourceAddressingCapabilities: [
      {
        capability: capability("multi.addressing"),
        inputRequirement: {
          sourceIdentity: "multi",
          displayName: "Multi fixture",
          fields: [
            {
              key: "address",
              label: "Address",
              required: true,
              acceptedInput: "opaque address",
            },
          ],
        },
        normalize(input) {
          const address = input.address;
          return typeof address !== "string" || address.length === 0
            ? { status: "invalid" as const, reason: "address required" }
            : {
                status: "accepted" as const,
                normalizedInput: { address },
                evidence: {
                  kind: "directed-source-address" as const,
                  sourceIdentity: "multi",
                  sourceAddress: address,
                  explanation: "fixture query address",
                  producer: capability("multi.addressing"),
                },
              };
        },
      },
    ],
    sourceAssociationInterpreters: [
      {
        capability: capability("multi.association"),
        canInterpret: () => true,
        interpret: () => ({
          status: "accepted" as const,
          explanation: "fixture source association",
        }),
      },
    ],
    sourceEnrichmentPersistence: persistence,
    configurationCompatibility: {
      async checkCompatibility() {
        return { compatible: true };
      },
    },
    changeImpactQueries: persistence,
    changeImpactCommands: persistence,
  });
}

describe("SQLite Asset Refresh persistence", () => {
  it("keeps one active local title and cover across reevaluation, restart, removal, and repetition", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const cataloguePath = path.join(root, "catalogue.sqlite");
    const record = (revision: number) => ({
      id: `local-lifecycle-record-${revision}`,
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: `2026-07-30T00:00:0${revision}.000Z`,
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: `local-lifecycle-record-digest-${revision}`,
      body: "{}",
    });
    const recognition = (
      revision: number,
      title: string | undefined,
      hasCover: boolean,
      current?: AcceptedRecognition,
    ): AcceptedRecognition => {
      const sourceRecord = record(revision);
      const proposal = {
        ...accepted().proposal,
        id: `local-lifecycle-proposal-${revision}`,
        basis: {
          kind: "source-interpretation" as const,
          interpretation: {
            ...accepted().proposal.basis.interpretation,
            id: `local-lifecycle-interpretation-${revision}`,
            sourceRecordIds: [sourceRecord.id],
            metadata: [
              {
                property: "book.isbn-13",
                sourceSlot: "source.isbn",
                value: "9780306406157",
                sourceRecordIds: [sourceRecord.id],
              },
            ],
            sourceArtifacts: [],
            entities: [],
            entityMentions: [],
            entityResolutionDecisions: [],
            relationships: [],
          },
        },
      };
      const parentId = `local-parent-${revision}`;
      const parentRevisionId = `local-parent-revision-${revision}`;
      const coverId = `local-cover-${revision}`;
      return {
        ...accepted(),
        proposal,
        entity: current?.entity ?? accepted().entity,
        recognitionSourceAssociation: current?.recognitionSourceAssociation ?? {
          ...accepted().recognitionSourceAssociation!,
          proposalId: proposal.id,
        },
        sourceAssociations: [
          current?.recognitionSourceAssociation ?? {
            ...accepted().recognitionSourceAssociation!,
            proposalId: proposal.id,
          },
        ],
        recognitionDecision: {
          ...(current?.recognitionDecision ?? {
            ...accepted().recognitionDecision,
            proposalId: proposal.id,
          }),
        },
        metadata: [
          ...proposal.basis.interpretation.metadata.map((assertion) => ({
            ...assertion,
            target: { kind: "entity" as const, entityId: "asset" },
          })),
          ...(title === undefined
            ? []
            : [
                {
                  target: {
                    kind: "artifact-revision" as const,
                    artifactId: parentId,
                    revisionId: parentRevisionId,
                  },
                  property: "asset.title",
                  sourceSlot: "epub.opf.title",
                  value: title,
                  sourceRecordIds: [],
                  observedArtifactPart: {
                    artifactId: parentId,
                    revisionId: parentRevisionId,
                    locator: "epub:opf/dc:title[1]",
                  },
                },
              ]),
        ],
        entities: [],
        entityMentions: [],
        entityResolutionDecisions: [],
        relationships: [],
        artifacts: [{ id: parentId }, ...(hasCover ? [{ id: coverId }] : [])],
        locations: [
          {
            id: `local-parent-location-${revision}`,
            artifactId: parentId,
            address: `/observed/book-${revision}.epub`,
            kind: "observed",
          },
          ...(hasCover
            ? [
                {
                  id: `local-cover-location-${revision}`,
                  artifactId: coverId,
                  address: `/managed/cover-${revision}.jpg`,
                  kind: "managed" as const,
                },
              ]
            : []),
        ],
        blobs: [
          {
            digest: `local-parent-digest-${revision}`,
            mediaType: "application/epub+zip",
            byteLength: 100 + revision,
          },
          ...(hasCover
            ? [
                {
                  digest: `local-cover-digest-${revision}`,
                  mediaType: "image/jpeg",
                  byteLength: 10 + revision,
                },
              ]
            : []),
        ],
        artifactRevisions: [
          {
            id: parentRevisionId,
            artifactId: parentId,
            blobDigest: `local-parent-digest-${revision}`,
          },
          ...(hasCover
            ? [
                {
                  id: `local-cover-revision-${revision}`,
                  artifactId: coverId,
                  blobDigest: `local-cover-digest-${revision}`,
                },
              ]
            : []),
        ],
        artifactAssociations: hasCover
          ? [
              {
                id: `local-cover-association-${revision}`,
                target: { kind: "entity" as const, entityId: "asset" },
                artifactId: coverId,
                role: "asset.primary-cover",
                observedArtifactPart: {
                  artifactId: parentId,
                  revisionId: parentRevisionId,
                  locator: "epub:manifest/cover",
                },
              },
            ]
          : [],
      };
    };
    const completeExecution = (
      id: string,
      fact: AcceptedRecognition,
    ): WorkflowExecution => ({
      ...execution(),
      id,
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      acceptedAssetId: fact.entity.id,
      proposalId: fact.proposal.id,
    });
    const refresh = async (
      adapter: SqliteCatalogue,
      id: string,
      current: AcceptedRecognition,
      next: AcceptedRecognition,
      revision: number,
    ) => {
      const running = { ...execution(), id };
      await adapter.createExecution(running);
      const heads = await adapter.freezeSourceLineageHeads({
        assetId: current.entity.id,
        sourceAssociation: current.recognitionSourceAssociation,
        coverageIds: ["complete"],
      });
      const nextRecord = record(revision);
      await retainSourceRecords(adapter, id, [nextRecord]);
      await adapter.refreshAcceptedRecognition({
        expectedExecution: await executionBaseline(adapter, id),
        execution: completeExecution(id, next),
        current,
        accepted: next,
        sourceRecords: [nextRecord],
        expectedLineageHeads: heads,
      });
    };
    const activeLocalTitle = (fact: AcceptedRecognition | undefined) =>
      fact?.metadata.filter(
        (item) =>
          item.property === "asset.title" &&
          item.sourceSlot === "epub.opf.title",
      );
    const activeCovers = (fact: AcceptedRecognition | undefined) =>
      fact?.artifactAssociations.filter(
        (item) => item.role === "asset.primary-cover",
      );

    const first = recognition(1, "旧标题", true);
    await catalogue.createExecution({
      ...execution(),
      id: "local-lifecycle-initial",
    });
    await retainSourceRecords(catalogue, "local-lifecycle-initial", [
      record(1),
    ]);
    await acceptRecognition(catalogue, {
      execution: completeExecution("local-lifecycle-initial", first),
      accepted: first,
    });

    const second = recognition(2, "新标题", true, first);
    await refresh(catalogue, "local-lifecycle-second", first, second, 2);
    const lifecycleAfterSecond = new DatabaseSync(cataloguePath);
    expect(
      lifecycleAfterSecond
        .prepare(
          `SELECT assertion_id, predecessor_assertion_id
           FROM metadata_assertion_lifecycles
           WHERE source_identity = 'local-observed'`,
        )
        .all(),
    ).toEqual([
      {
        assertion_id: expect.any(Number),
        predecessor_assertion_id: null,
      },
    ]);
    lifecycleAfterSecond.close();
    const afterSecond = (
      await catalogue.inspectExecution("local-lifecycle-second")
    )?.accepted;
    if (afterSecond === undefined) throw new Error("missing second acceptance");
    expect(activeLocalTitle(afterSecond)?.map((item) => item.value)).toEqual([
      "新标题",
    ]);
    expect(activeCovers(afterSecond)?.map((item) => item.id)).toEqual([
      "local-cover-association-2",
    ]);

    catalogue.close();
    const reopened = SqliteCatalogue.forProductData(root);
    const afterRestart = (
      await reopened.inspectExecution("local-lifecycle-second")
    )?.accepted;
    expect(activeLocalTitle(afterRestart)?.map((item) => item.value)).toEqual([
      "新标题",
    ]);
    expect(activeCovers(afterRestart)?.map((item) => item.id)).toEqual([
      "local-cover-association-2",
    ]);

    const third = recognition(3, undefined, false, afterSecond);
    await refresh(reopened, "local-lifecycle-third", afterSecond, third, 3);
    const afterRemoval = (
      await reopened.inspectExecution("local-lifecycle-third")
    )?.accepted;
    if (afterRemoval === undefined) throw new Error("missing third acceptance");
    expect(activeLocalTitle(afterRemoval)).toEqual([]);
    expect(activeCovers(afterRemoval)).toEqual([]);

    const beforeRepeat = new DatabaseSync(cataloguePath);
    const historicalCounts = {
      titles: (
        beforeRepeat
          .prepare(
            `SELECT COUNT(*) AS count FROM metadata_assertions
             WHERE property = 'asset.title' AND source_slot = 'epub.opf.title'`,
          )
          .get() as { readonly count: number }
      ).count,
      covers: (
        beforeRepeat
          .prepare(
            `SELECT COUNT(*) AS count FROM artifact_associations
             WHERE role = 'asset.primary-cover'`,
          )
          .get() as { readonly count: number }
      ).count,
    };
    beforeRepeat.close();
    expect(historicalCounts).toEqual({ titles: 2, covers: 2 });

    const fourth = recognition(4, undefined, false, afterRemoval);
    await refresh(reopened, "local-lifecycle-fourth", afterRemoval, fourth, 4);
    const afterRepeat = (
      await reopened.inspectExecution("local-lifecycle-fourth")
    )?.accepted;
    expect(activeLocalTitle(afterRepeat)).toEqual([]);
    expect(activeCovers(afterRepeat)).toEqual([]);
    reopened.close();

    const history = new DatabaseSync(cataloguePath);
    expect(
      (
        history
          .prepare(
            `SELECT COUNT(*) AS count FROM metadata_assertions
             WHERE property = 'asset.title' AND source_slot = 'epub.opf.title'`,
          )
          .get() as { readonly count: number }
      ).count,
    ).toBe(historicalCounts.titles);
    expect(
      (
        history
          .prepare(
            `SELECT COUNT(*) AS count FROM artifact_associations
             WHERE role = 'asset.primary-cover'`,
          )
          .get() as { readonly count: number }
      ).count,
    ).toBe(historicalCounts.covers);
    history.close();
  });

  it("retains local EPUB facts across a restart and refuses rewritten stable parent provenance", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution(execution());
    const record = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/endpoint",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "record-digest",
      body: "{}",
    };
    await retainSourceRecords(catalogue, "execution", [record]);
    const fact = accepted();
    const parent = { id: "epub-artifact" };
    const cover = { id: "cover-artifact" };
    fact.artifacts = [parent, cover];
    fact.locations = [
      {
        id: "epub-location",
        artifactId: parent.id,
        address: "/observed/book.epub",
        kind: "observed",
      },
      {
        id: "cover-location",
        artifactId: cover.id,
        address: "/managed/cover",
        kind: "managed",
      },
    ];
    fact.blobs = [
      {
        digest: "epub-digest",
        mediaType: "application/epub+zip",
        byteLength: 100,
      },
      { digest: "cover-digest", mediaType: "image/jpeg", byteLength: 4 },
    ];
    fact.artifactRevisions = [
      { id: "epub-revision", artifactId: parent.id, blobDigest: "epub-digest" },
      {
        id: "cover-revision",
        artifactId: cover.id,
        blobDigest: "cover-digest",
      },
    ];
    fact.artifactAssociations = [
      {
        id: "cover-association",
        target: { kind: "entity" as const, entityId: "asset" },
        artifactId: cover.id,
        role: "asset.primary-cover",
        observedArtifactPart: {
          artifactId: parent.id,
          revisionId: "epub-revision",
          locator: "epub:cover",
        },
      },
    ];
    fact.metadata = [
      ...fact.metadata,
      {
        target: {
          kind: "artifact-revision" as const,
          artifactId: parent.id,
          revisionId: "epub-revision",
        },
        property: "asset.title",
        sourceSlot: "epub.opf.title",
        value: "本地标题",
        sourceRecordIds: [],
        observedArtifactPart: {
          artifactId: parent.id,
          revisionId: "epub-revision",
          locator: "epub:opf/dc:title[1]",
        },
      },
    ];
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: fact,
    });
    catalogue.close();
    const later = SqliteCatalogue.forProductData(root);
    const inspected = await later.inspectExecution("execution");
    const local = inspected?.accepted?.metadata.find(
      (item) => item.sourceSlot === "epub.opf.title",
    );
    expect(local).toMatchObject({
      property: "asset.title",
      sourceRecordIds: [],
      observedArtifactPart: {
        artifactId: parent.id,
        revisionId: "epub-revision",
        locator: "epub:opf/dc:title[1]",
      },
    });
    expect(inspected?.accepted?.artifactAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observedArtifactPart: expect.objectContaining({
            artifactId: parent.id,
            revisionId: "epub-revision",
          }),
        }),
      ]),
    );
    const refreshExecution = { ...execution(), id: "local-provenance-refresh" };
    await later.createExecution(refreshExecution);
    const refreshRecord = {
      ...record,
      id: "local-provenance-refresh-record",
      acquiredAt: "2026-07-30T00:00:00.000Z",
    };
    await retainSourceRecords(later, refreshExecution.id, [refreshRecord]);
    const refreshedProposal = {
      ...fact.proposal,
      id: "local-provenance-refresh-proposal",
      basis: {
        kind: "source-interpretation" as const,
        interpretation: {
          ...fact.proposal.basis.interpretation,
          id: "local-provenance-refresh-interpretation",
          sourceRecordIds: [refreshRecord.id],
          metadata: fact.proposal.basis.interpretation.metadata.map(
            (metadata) => ({
              ...metadata,
              sourceRecordIds: [refreshRecord.id],
            }),
          ),
          entities: [],
          entityMentions: [],
          entityResolutionDecisions: [],
          relationships: [],
        },
      },
    };
    const refreshed = {
      ...fact,
      proposal: refreshedProposal,
      metadata: fact.metadata.map((metadata) => ({
        ...metadata,
        ...(metadata.sourceRecordIds.length === 0
          ? {}
          : { sourceRecordIds: [refreshRecord.id] }),
      })),
      entities: [],
      entityMentions: [],
      entityResolutionDecisions: [],
      relationships: [],
      artifactAssociations: fact.artifactAssociations.map((association) => ({
        ...association,
        observedArtifactPart:
          association.observedArtifactPart === undefined
            ? undefined
            : {
                ...association.observedArtifactPart,
                locator: "epub:another-cover",
              },
      })),
    };
    const heads = await later.freezeSourceLineageHeads({
      assetId: fact.entity.id,
      sourceAssociation: fact.recognitionSourceAssociation,
      coverageIds: [record.coverage.id],
    });
    await expect(
      later.refreshAcceptedRecognition({
        expectedExecution: await executionBaseline(later, refreshExecution.id),
        execution: refreshExecution,
        current: fact,
        accepted: refreshed,
        sourceRecords: [refreshRecord],
        expectedLineageHeads: heads,
      }),
    ).rejects.toThrow(
      "Stable Artifact Association cover-association conflicts with observed-part provenance",
    );
    later.close();
  });
  it("reevaluates a stable work-item identity without adding asset, association, or decision rows", async () => {
    const { catalogue, root } = await createCatalogueWithRoot();
    const initialRecord = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "initial-digest",
      body: "{}",
    };
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [initialRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });
    const current = (await catalogue.inspectExecution("execution"))!.accepted!;
    await saveCurrentAttentionPreview(catalogue, {
      executionId: "reevaluation-preview-owner",
      previewId: "reevaluation-sibling-preview",
      accepted: current,
    });
    const reevaluation = {
      ...execution(),
      id: "reevaluation",
      workItems: [
        {
          key: "exact-boundary",
          relativePaths: ["work.bin"],
          sourceRecordIds: ["reevaluated-record"],
          proposalId: "reevaluated-proposal",
          acceptedAssetId: current.entity.id,
          outcome: "accepted" as const,
        },
      ],
    };
    const reevaluatedRecord = {
      ...initialRecord,
      id: "reevaluated-record",
      acquiredAt: "2026-07-30T00:00:00.000Z",
      digest: "reevaluated-digest",
    };
    await catalogue.createExecution(reevaluation);
    const expectedLineageHeads = await catalogue.freezeSourceLineageHeads({
      assetId: current.entity.id,
      sourceAssociation: current.recognitionSourceAssociation,
      coverageIds: ["complete"],
    });
    await retainSourceRecords(catalogue, "reevaluation", [reevaluatedRecord]);
    const refreshed = {
      ...accepted(),
      proposal: {
        ...accepted().proposal,
        id: "reevaluated-proposal",
        basis: {
          kind: "source-interpretation" as const,
          interpretation: {
            ...accepted().proposal.basis.interpretation,
            id: "reevaluated-interpretation",
            sourceRecordIds: ["reevaluated-record"],
            metadata: [
              {
                property: "asset.title",
                sourceSlot: "source.title",
                value: "Reevaluated work",
                sourceRecordIds: ["reevaluated-record"],
              },
            ],
            sourceArtifacts: [],
            entityMentions: [],
            entityResolutionDecisions: [],
            entities: [],
            relationships: [],
          },
        },
      },
      entity: current.entity,
      recognitionSourceAssociation: current.recognitionSourceAssociation,
      sourceAssociations: current.sourceAssociations,
      recognitionDecision: current.recognitionDecision,
      metadata: [
        {
          target: { kind: "entity" as const, entityId: current.entity.id },
          property: "asset.title",
          sourceSlot: "source.title",
          value: "Reevaluated work",
          sourceRecordIds: ["reevaluated-record"],
        },
      ],
      entities: [],
      entityMentions: [],
      entityResolutionDecisions: [],
      relationships: [],
    };
    await catalogue.refreshAcceptedRecognition({
      expectedExecution: await executionBaseline(catalogue, reevaluation.id),
      execution: {
        ...reevaluation,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        acceptedAssetId: current.entity.id,
      },
      current,
      accepted: refreshed,
      sourceRecords: [reevaluatedRecord],
      expectedLineageHeads,
    });
    await expect(
      catalogue.inspectChangeImpactPreview("reevaluation-sibling-preview"),
    ).resolves.toMatchObject({ status: "stale" });

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    for (const [table, predicate] of [
      ["entity_kind_assertions", "kind = 'digital-asset'"],
      ["source_associations", "1 = 1"],
      ["recognition_decisions", "1 = 1"],
    ]) {
      expect(
        (
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`,
            )
            .get() as {
            readonly count: number;
          }
        ).count,
      ).toBe(1);
    }
    database.close();
    await expect(
      catalogue.inspectExecution("reevaluation"),
    ).resolves.toMatchObject({
      accepted: {
        entity: { id: "asset" },
        metadata: [{ value: "Reevaluated work" }],
      },
    });
  });

  it("rolls back an accepted reevaluation when its new artifact association cannot be retained", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const initialRecord = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/endpoint",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "initial-digest",
      body: "{}",
    };
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [initialRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });
    const current = (await catalogue.inspectExecution("execution"))!.accepted!;
    const reevaluation = {
      ...execution(),
      id: "atomic-reevaluation",
      workItems: [
        {
          key: "exact-boundary",
          relativePaths: ["work.bin"],
          sourceRecordIds: ["atomic-record"],
        },
      ],
    };
    const nextRecord = {
      ...initialRecord,
      id: "atomic-record",
      acquiredAt: "2026-07-30T00:00:00.000Z",
      digest: "atomic-digest",
    };
    await catalogue.createExecution(reevaluation);
    const expectedLineageHeads = await catalogue.freezeSourceLineageHeads({
      assetId: current.entity.id,
      sourceAssociation: current.recognitionSourceAssociation,
      coverageIds: ["complete"],
    });
    await retainSourceRecords(catalogue, reevaluation.id, [nextRecord]);
    const next: AcceptedRecognition = {
      ...current,
      proposal: {
        ...current.proposal,
        id: "atomic-proposal",
        basis: {
          kind: "source-interpretation",
          interpretation: {
            ...current.proposal.basis.interpretation,
            id: "atomic-interpretation",
            sourceRecordIds: [nextRecord.id],
            metadata: [
              {
                property: "asset.title",
                sourceSlot: "source.title",
                value: "Atomic replacement",
                sourceRecordIds: [nextRecord.id],
              },
            ],
            entities: [
              {
                id: "atomic-persona",
                kind: "persona",
                sourceIdentity: "source",
                sourceKey: "atomic-persona",
                identityNamespace: "source.credit.voice",
                label: "Atomic persona",
                sourceRecordIds: [nextRecord.id],
              },
            ],
            entityMentions: [],
            entityResolutionDecisions: [],
            relationships: [
              {
                id: "atomic-relationship",
                participants: [{ entityId: "atomic-persona", role: "voice" }],
                subjectRole: "asset",
                type: "asset.contribution",
                sourceSlot: "source.credit.voice",
                sourceRecordIds: [nextRecord.id],
              },
            ],
            sourceArtifacts: [],
          },
        },
      },
      metadata: [
        {
          target: { kind: "entity", entityId: current.entity.id },
          property: "asset.title",
          sourceSlot: "source.title",
          value: "Atomic replacement",
          sourceRecordIds: [nextRecord.id],
        },
      ],
      entities: [
        {
          id: "atomic-persona",
          kind: "persona",
          sourceIdentity: "source",
          sourceKey: "atomic-persona",
          identityNamespace: "source.credit.voice",
          label: "Atomic persona",
          sourceRecordIds: [nextRecord.id],
        },
      ],
      entityMentions: [],
      entityResolutionDecisions: [],
      relationships: [
        {
          id: "atomic-relationship",
          participants: [
            { entityId: current.entity.id, role: "asset" },
            { entityId: "atomic-persona", role: "voice" },
          ],
          type: "asset.contribution",
          sourceSlot: "source.credit.voice",
          sourceRecordIds: [nextRecord.id],
        },
      ],
      artifacts: [...current.artifacts, { id: "atomic-artifact" }],
      locations: [
        ...current.locations,
        {
          id: "atomic-location",
          artifactId: "atomic-artifact",
          address: "/managed/atomic",
          kind: "managed",
        },
      ],
      blobs: [
        ...current.blobs,
        {
          digest: "atomic-blob",
          mediaType: "image/png",
          byteLength: 8,
        },
      ],
      artifactRevisions: [
        ...current.artifactRevisions,
        {
          id: "atomic-revision",
          artifactId: "atomic-artifact",
          blobDigest: "atomic-blob",
        },
      ],
      artifactAssociations: [
        {
          id: "atomic-association",
          target: { kind: "entity" as const, entityId: current.entity.id },
          artifactId: "atomic-artifact",
          role: "asset.primary-cover",
          sourceRecordIds: [nextRecord.id],
        },
      ],
    };
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const count = (table: string) =>
      (
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          readonly count: number;
        }
      ).count;
    const before = {
      proposals: count("recognition_proposals"),
      lineage: count("source_lineage_heads"),
      metadata: count("metadata_assertions"),
      metadataLifecycle: count("metadata_assertion_lifecycles"),
      relationships: count("entity_relationships"),
      relationshipLifecycle: count("relationship_lifecycles"),
      artifacts: count("artifacts"),
      revisions: count("artifact_revisions"),
      locations: count("locations"),
      associations: count("artifact_associations"),
    };
    database.exec(
      `CREATE TRIGGER fail_atomic_association
       BEFORE INSERT ON artifact_associations
       WHEN NEW.id = 'atomic-association'
       BEGIN SELECT RAISE(ABORT, 'injected artifact association failure'); END`,
    );

    await expect(
      catalogue.refreshAcceptedRecognition({
        expectedExecution: await executionBaseline(catalogue, reevaluation.id),
        execution: {
          ...reevaluation,
          status: "completed",
          stage: "completed",
          outcome: "accepted",
          acceptedAssetId: current.entity.id,
          proposalId: next.proposal.id,
          workItems: [
            {
              ...reevaluation.workItems[0],
              proposalId: next.proposal.id,
              acceptedAssetId: current.entity.id,
              outcome: "accepted",
            },
          ],
        },
        current,
        accepted: next,
        sourceRecords: [nextRecord],
        expectedLineageHeads,
      }),
    ).rejects.toThrow("injected artifact association failure");

    expect({
      proposals: count("recognition_proposals"),
      lineage: count("source_lineage_heads"),
      metadata: count("metadata_assertions"),
      metadataLifecycle: count("metadata_assertion_lifecycles"),
      relationships: count("entity_relationships"),
      relationshipLifecycle: count("relationship_lifecycles"),
      artifacts: count("artifacts"),
      revisions: count("artifact_revisions"),
      locations: count("locations"),
      associations: count("artifact_associations"),
    }).toEqual(before);
    expect(
      database
        .prepare(
          `SELECT source_record_id FROM source_lineage_heads
           WHERE subject_id = ? AND coverage_id = ?`,
        )
        .get(current.entity.id, "complete"),
    ).toEqual({ source_record_id: initialRecord.id });
    database.close();
    await expect(
      catalogue.inspectExecution(reevaluation.id),
    ).resolves.toMatchObject({
      execution: {
        status: "running",
        workItems: [{ key: "exact-boundary" }],
      },
    });
  });

  it("rejects a stable artifact-association id whose durable contents differ", async () => {
    const catalogue = await createCatalogue();
    await catalogue.createExecution(execution());
    const record = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/endpoint",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: "{}",
    };
    await retainSourceRecords(catalogue, "execution", [record]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });
    const secondExecution = { ...execution(), id: "collision-execution" };
    await catalogue.createExecution(secondExecution);
    const collisionRecord = {
      ...record,
      id: "collision-record",
      acquiredAt: "2026-07-30T00:00:00.000Z",
    };
    await retainSourceRecords(catalogue, secondExecution.id, [collisionRecord]);
    const proposal = {
      ...accepted().proposal,
      id: "collision-proposal",
      basis: {
        kind: "source-interpretation" as const,
        interpretation: {
          ...accepted().proposal.basis.interpretation,
          id: "collision-interpretation",
          sourceRecordIds: [collisionRecord.id],
          metadata: [],
          entities: [],
          entityMentions: [],
          entityResolutionDecisions: [],
          relationships: [],
        },
      },
    };
    await expect(
      acceptRecognition(catalogue, {
        execution: {
          ...secondExecution,
          status: "completed",
          stage: "completed",
          outcome: "accepted",
          acceptedAssetId: "collision-asset",
          proposalId: proposal.id,
        },
        accepted: {
          ...accepted(),
          proposal,
          entity: { id: "collision-asset", kind: "digital-asset" },
          recognitionSourceAssociation: {
            id: "collision-source-association",
            subjectId: "collision-asset",
            sourceIdentity: "source",
            nativeAddress: "https://source.example/work",
            proposalId: proposal.id,
          },
          sourceAssociations: [
            {
              id: "collision-source-association",
              subjectId: "collision-asset",
              sourceIdentity: "source",
              nativeAddress: "https://source.example/work",
              proposalId: proposal.id,
            },
          ],
          recognitionDecision: {
            id: "collision-decision",
            proposalId: proposal.id,
            assetId: "collision-asset",
            acceptedRuleResults: proposal.ruleResults,
          },
          metadata: [],
          entities: [],
          entityMentions: [],
          entityResolutionDecisions: [],
          relationships: [],
          artifactAssociations: [
            {
              ...accepted().artifactAssociations[0],
              target: { kind: "entity", entityId: "collision-asset" },
            },
          ],
        },
      }),
    ).rejects.toThrow(
      "Stable Artifact Association artifact-association conflicts with durable history",
    );
    await expect(
      catalogue.inspectExecution(secondExecution.id),
    ).resolves.toMatchObject({
      execution: { status: "running" },
    });
  });

  it("reevaluates changed observations with expanded source facts and one current managed association", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      observedDigest: "reevaluation-shared-observed-digest",
      stableObservedByteLength: true,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await workflow.scanObservedScope({
      registrationId: "/observed/reevaluation",
      relativeScope: ".",
      executionId: "real-reevaluation-initial",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.title", necessity: "required" }],
        artifactRoles: [
          {
            role: "asset.primary-cover",
            necessity: "required",
            maximum: 1,
          },
        ],
        relationshipTypes: [],
      },
    });
    expect(initial.execution.outcome, JSON.stringify(initial.execution)).toBe(
      "accepted",
    );
    const initialHistoryBeforeReevaluation = (
      await catalogue.listWorkflowHistoryPage({ limit: 10 })
    ).items.find(({ execution }) => execution.id === initial.execution.id)!;
    const frozenInitialHistory = JSON.stringify(
      initialHistoryBeforeReevaluation,
    );
    const initialAccepted = (
      await catalogue.inspectExecution(initial.execution.id)
    )?.workItemInspections?.[0]?.accepted;
    const predecessorObserved = initialAccepted?.locations.find(
      (location) =>
        location.kind === "observed" &&
        location.address === "/observed/reevaluation/work.bin",
    );
    expect(predecessorObserved).toBeDefined();
    const predecessor = initialAccepted?.artifactAssociations.find(
      (association) => association.role === "asset.primary-cover",
    );
    expect(predecessor).toBeDefined();
    expect(
      await catalogue.findAcceptedForWorkItem({
        directory: "/observed/reevaluation",
        relativePaths: ["work.bin"],
      }),
    ).toBeDefined();
    const identityBeforeDatabase = new DatabaseSync(
      path.join(root, "catalogue.sqlite"),
    );
    const identityBefore = {
      association: identityBeforeDatabase
        .prepare(
          `SELECT id, subject_id, source_identity, native_address
           FROM source_associations WHERE id = ?`,
        )
        .get(initialAccepted!.recognitionSourceAssociation.id),
      decision: identityBeforeDatabase
        .prepare(
          `SELECT id, proposal_id, asset_id, accepted_rule_results_json
           FROM recognition_decisions WHERE id = ?`,
        )
        .get(initialAccepted!.recognitionDecision.id),
      head: identityBeforeDatabase
        .prepare(
          `SELECT subject_id, recognition_source_association_id, recognition_decision_id
           FROM recognition_heads WHERE subject_id = ?`,
        )
        .get(initialAccepted!.entity.id),
    };
    identityBeforeDatabase.close();
    expect(identityBefore.association).toBeDefined();
    expect(identityBefore.decision).toBeDefined();
    expect(identityBefore.head).toBeDefined();

    state.observationVersion = 1;
    state.expanded = true;
    const refreshed = await workflow.scanObservedScope({
      registrationId: "/observed/reevaluation",
      relativeScope: ".",
      executionId: "real-reevaluation-expanded",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [
          { property: "asset.title", necessity: "required" },
          { property: "asset.summary", necessity: "required" },
        ],
        artifactRoles: [
          {
            role: "asset.primary-cover",
            necessity: "required",
            maximum: 1,
          },
        ],
        relationshipTypes: [
          { type: "asset.contribution", necessity: "required" },
        ],
      },
    });

    expect(refreshed.execution.workItems?.[0]?.reason).toBeUndefined();
    expect(refreshed.execution.outcome).toBe("accepted");
    const refreshedAccepted = (
      await catalogue.inspectExecution(refreshed.execution.id)
    )?.workItemInspections?.[0]?.accepted;
    expect(refreshedAccepted).toMatchObject({
      metadata: expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Reevaluation title 2",
        }),
        expect.objectContaining({
          property: "asset.summary",
          value: "Expanded summary",
        }),
      ]),
      relationships: expect.arrayContaining([
        expect.objectContaining({
          participants: expect.arrayContaining([
            expect.objectContaining({ role: "asset" }),
            expect.objectContaining({ role: "voice" }),
          ]),
        }),
        expect.objectContaining({
          participants: expect.arrayContaining([
            expect.objectContaining({ role: "asset" }),
            expect.objectContaining({ role: "editing" }),
          ]),
        }),
      ]),
    });
    expect(refreshedAccepted?.recognitionSourceAssociation).toEqual(
      initialAccepted?.recognitionSourceAssociation,
    );
    expect(refreshedAccepted?.recognitionDecision).toEqual(
      initialAccepted?.recognitionDecision,
    );
    const initialHistoryAfterReevaluation = (
      await catalogue.listWorkflowHistoryPage({ limit: 10 })
    ).items.find(({ execution }) => execution.id === initial.execution.id)!;
    expect(JSON.stringify(initialHistoryAfterReevaluation)).toBe(
      frozenInitialHistory,
    );
    await expect(
      catalogue.listCurrentAttentionPage({ limit: 10 }),
    ).resolves.toEqual({ items: [] });
    const currentCover = refreshedAccepted?.artifactAssociations.find(
      (association) => association.role === "asset.primary-cover",
    );
    expect(currentCover?.id).not.toBe(predecessor?.id);

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const count = (table: string, predicate = "1 = 1") =>
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`)
          .get() as { readonly count: number }
      ).count;
    const observedArtifacts = database
      .prepare(
        `SELECT DISTINCT artifact_id
         FROM locations
         WHERE kind = 'observed' AND address = '/observed/reevaluation/work.bin'
         ORDER BY artifact_id`,
      )
      .all() as readonly { readonly artifact_id: string }[];
    expect(observedArtifacts).toHaveLength(2);
    expect(observedArtifacts).toEqual(
      expect.arrayContaining([
        { artifact_id: predecessorObserved!.artifactId },
      ]),
    );
    expect(
      count("blobs", "digest = 'reevaluation-shared-observed-digest'"),
    ).toBe(1);
    expect(
      count(
        "artifact_revisions",
        "blob_digest = 'reevaluation-shared-observed-digest'",
      ),
    ).toBe(2);
    const artifactsSharingObservedBlob = database
      .prepare(
        `SELECT DISTINCT artifact_id
         FROM artifact_revisions
         WHERE blob_digest = 'reevaluation-shared-observed-digest'
         ORDER BY artifact_id`,
      )
      .all();
    expect(artifactsSharingObservedBlob).toEqual(observedArtifacts);
    expect(count("entity_kind_assertions", "kind = 'digital-asset'")).toBe(1);
    expect(count("source_associations")).toBe(1);
    expect(count("recognition_decisions")).toBe(1);
    expect(
      database
        .prepare(
          `SELECT id, subject_id, source_identity, native_address
           FROM source_associations WHERE id = ?`,
        )
        .get(initialAccepted!.recognitionSourceAssociation.id),
    ).toEqual(identityBefore.association);
    expect(
      database
        .prepare(
          `SELECT id, proposal_id, asset_id, accepted_rule_results_json
           FROM recognition_decisions WHERE id = ?`,
        )
        .get(initialAccepted!.recognitionDecision.id),
    ).toEqual(identityBefore.decision);
    expect(
      database
        .prepare(
          `SELECT subject_id, recognition_source_association_id, recognition_decision_id
           FROM recognition_heads WHERE subject_id = ?`,
        )
        .get(initialAccepted!.entity.id),
    ).toEqual(identityBefore.head);
    expect(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM recognition_decision_supersessions
             WHERE predecessor_decision_id = ?`,
          )
          .get(initialAccepted!.recognitionDecision.id) as {
          readonly count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      database
        .prepare(
          `SELECT predecessor_assertion_id FROM metadata_assertion_lifecycles
           WHERE predecessor_assertion_id IS NOT NULL`,
        )
        .get(),
    ).toBeDefined();
    expect(
      database
        .prepare(
          `SELECT predecessor_relationship_id FROM relationship_lifecycles
           WHERE predecessor_relationship_id IS NOT NULL`,
        )
        .get(),
    ).toBeUndefined();
    const associationLifecycle =
      database
        .prepare(
          `SELECT successor_association_id
           FROM artifact_association_supersessions
           WHERE predecessor_association_id = ?`,
        )
        .get(predecessor!.id) ??
      database
        .prepare(
          `SELECT id FROM artifact_association_retractions
           WHERE association_id = ?`,
        )
        .get(predecessor!.id);
    expect(associationLifecycle).toBeDefined();
    expect(
      database
        .prepare(`SELECT artifact_id FROM artifact_associations WHERE id = ?`)
        .get(predecessor!.id),
    ).toEqual({ artifact_id: predecessor!.artifactId });
    database.close();
  });

  it("drives a public metadata refresh through a durable Source Refresh Run", async () => {
    const catalogue = await createCatalogue();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-authority",
      executionId: "source-refresh-authority-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();

    const refreshed = await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: current!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      initiatedBy: "user-1",
    });

    expect(refreshed.execution).toMatchObject({
      status: "completed",
      outcome: "accepted",
      sourceRefreshRunIds: [expect.any(String)],
      workflowInput: {
        trigger: "interactive",
        initiatedBy: "user-1",
      },
    });
    expect(refreshed.sourceRefreshRuns).toMatchObject([
      {
        initiatedBy: "user-1",
        requestedSelection: {
          subjectId: current!.entity.id,
          sourceAssociationId: current!.recognitionSourceAssociation.id,
        },
        phase: "terminal",
        outcome: "succeeded",
      },
    ]);
    expect(refreshed.execution.dispositions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("source-refresh:"),
        }),
      ]),
    );
    expect(refreshed.accepted?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Reevaluation title 2",
        }),
      ]),
    );
  });

  it("正式来源刷新保持人工指称并在重开撤回到刷新后的自动依据", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      relatedMention: true,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/related-refresh",
      executionId: "related-refresh-initial",
      acceptTrusted: true,
    });
    const subject = (await catalogue.inspectExecution(initial.execution.id))!
      .accepted!;
    const local = await workflow.createLocalRelatedEntity({
      commitmentId: "related-refresh/1",
      label: "本地声优",
      kind: "entity",
      actorId: "user:甲",
    });
    const fix = {
      kind: "fix" as const,
      definitionId: "fixture.membership",
      relationship: {
        type: "asset.membership",
        participants: [
          { entityId: subject.entity.id, role: "member" },
          { entityId: local.id, role: "performer" },
        ],
        qualifiers: [{ key: "asset.membership.position", value: "2" }],
      },
    };
    const repeatedFix = await workflow.previewRelationshipChange({
      changes: [fix, fix],
    });
    expect(
      repeatedFix.relationships.filter(
        (relationship) => relationship.type === "asset.membership",
      ),
    ).toHaveLength(1);
    await expect(
      workflow.applyRelationshipChange({
        actorId: "user:甲",
        preview: repeatedFix,
      }),
    ).resolves.toBe("applied");
    const automatic = await workflow.inspectEntityMentionResolution(
      "reevaluation-voice-mention",
    );
    await expect(
      workflow.resolveEntityMentionManually({
        mentionId: automatic.mentionId,
        entityId: local.id,
        actorId: "user:甲",
        baseline: automatic.baseline,
      }),
    ).resolves.toBe("applied");
    await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: subject.entity.id,
            explanations: [{ path: ["相关实体"] }],
          },
        ],
        filesystemScopes: [],
      },
      initiatedBy: "user:甲",
    });
    await expect(
      workflow.inspectEntityMentionResolution(automatic.mentionId),
    ).resolves.toMatchObject({
      basis: "manual",
      entityId: local.id,
    });
    await expect(
      workflow.inspectCurrentCatalogueEntity(local.id),
    ).resolves.toMatchObject({
      relationships: expect.arrayContaining([
        expect.objectContaining({
          type: "asset.membership",
          qualifiers: [{ key: "asset.membership.position", value: "2" }],
        }),
      ]),
    });
    await expect(
      workflow.inspectCurrentCatalogueEntity("reevaluation-persona"),
    ).resolves.toMatchObject({
      relationships: [],
    });
    catalogue.close();
    const reopened = SqliteCatalogue.forProductData(root);
    const reopenedWorkflow = reevaluationWorkflow(reopened, state);
    const afterReopen = await reopenedWorkflow.inspectEntityMentionResolution(
      automatic.mentionId,
    );
    expect(afterReopen).toMatchObject({ basis: "manual", entityId: local.id });
    await expect(
      reopenedWorkflow.inspectCurrentCatalogueEntity(local.id),
    ).resolves.toMatchObject({
      relationships: expect.arrayContaining([
        expect.objectContaining({ type: "asset.membership" }),
      ]),
    });
    const retraction = await reopenedWorkflow.retractEntityMentionResolution({
      mentionId: automatic.mentionId,
      actorId: "user:甲",
      baseline: afterReopen.baseline,
    });
    expect(retraction).toBe("applied");
    await expect(
      reopenedWorkflow.inspectEntityMentionResolution(automatic.mentionId),
    ).resolves.toMatchObject({
      basis: "source",
      entityId: "reevaluation-persona",
      sourceRecordIds: ["reevaluation-record-2"],
    });
    reopened.close();
  });

  it("正式来源刷新以当前种类断言取代旧断言并允许人工决定清除", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      personaKind: "persona" as const,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/related-refresh",
      executionId: "kind-refresh-initial",
      acceptTrusted: true,
    });
    const subject = (await catalogue.inspectExecution(initial.execution.id))!
      .accepted!.entity.id;
    state.personaKind = "person";
    await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          { subjectId: subject, explanations: [{ path: ["种类更正"] }] },
        ],
        filesystemScopes: [],
      },
      initiatedBy: "user:甲",
    });
    await expect(
      workflow.inspectCurrentCatalogueEntity("reevaluation-persona"),
    ).resolves.toMatchObject({
      entity: {
        kind: { status: "effective", kind: "person", basis: "assertion" },
      },
    });
    const preview = await workflow.previewEntityKindDecision({
      entityId: "reevaluation-persona",
      selectedKind: "persona",
    });
    await expect(
      workflow.applyEntityKindDecision({
        entityId: "reevaluation-persona",
        selectedKind: "persona",
        actorId: "user:甲",
        baseline: preview.baseline,
      }),
    ).resolves.toBe("applied");
    const clear = await workflow.previewEntityKindDecision({
      entityId: "reevaluation-persona",
    });
    await expect(
      workflow.applyEntityKindDecision({
        entityId: "reevaluation-persona",
        actorId: "user:甲",
        baseline: clear.baseline,
      }),
    ).resolves.toBe("applied");
    state.personaKind = "entity";
    await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          { subjectId: subject, explanations: [{ path: ["普通实体"] }] },
        ],
        filesystemScopes: [],
      },
      initiatedBy: "user:甲",
    });
    await expect(
      workflow.inspectCurrentCatalogueEntity("reevaluation-persona"),
    ).resolves.toMatchObject({ entity: { kind: { status: "ordinary" } } });
    catalogue.close();
    const reopened = SqliteCatalogue.forProductData(root);
    await expect(
      reopened.findRelatedEntities("Stable persona"),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: { status: "ordinary" } }),
      ]),
    );
    reopened.close();
  });

  it("两条来源谱系分别推进同一相关实体的当前种类", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const a = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      sourceAddress: "opaque:related-lineage-a",
      sourceRecordPrefix: "related-lineage-a-record",
      personaKind: "persona" as const,
    };
    const b = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      sourceAddress: "opaque:related-lineage-b",
      sourceRecordPrefix: "related-lineage-b-record",
      personaKind: "persona" as const,
    };
    const workflowA = reevaluationWorkflow(catalogue, a);
    const workflowB = reevaluationWorkflow(catalogue, b);
    const first = await scanFixtureRegisteredObservedScope(workflowA, {
      directory: "/observed/related-lineage-a",
      executionId: "related-lineage-a",
      acceptTrusted: true,
    });
    const second = await scanFixtureRegisteredObservedScope(workflowB, {
      directory: "/observed/related-lineage-b",
      executionId: "related-lineage-b",
      acceptTrusted: true,
    });
    expect(
      (await catalogue.inspectExecution(first.execution.id))?.accepted?.entity
        .id,
    ).not.toBe(
      (await catalogue.inspectExecution(second.execution.id))?.accepted?.entity
        .id,
    );
    const firstSubject = (await catalogue.inspectExecution(first.execution.id))!
      .accepted!.entity.id;
    const secondSubject = (await catalogue.inspectExecution(
      second.execution.id,
    ))!.accepted!.entity.id;
    const refresh = async (
      workflow: AssetRefreshWorkflow,
      subjectId: string,
      path: string,
    ) =>
      await workflow.refreshMetadata({
        selection: {
          version: "asset-refresh-selection/1",
          subjects: [{ subjectId, explanations: [{ path: [path] }] }],
          filesystemScopes: [],
        },
        initiatedBy: "user:甲",
      });
    // 首次刷新建立 B 的当前来源头；下一次同种类支持必须仍令旧预演过期。
    await refresh(workflowB, secondSubject, "B 建立当前支持");
    const beforeSameKindSupport = await workflowA.previewEntityKindDecision({
      entityId: "reevaluation-persona",
      selectedKind: "person",
    });
    await refresh(workflowB, secondSubject, "B 新增同种类支持");
    await expect(
      workflowA.applyEntityKindDecision({
        entityId: "reevaluation-persona",
        selectedKind: "person",
        actorId: "user:甲",
        baseline: beforeSameKindSupport.baseline,
      }),
    ).resolves.toBe("stale");
    a.personaKind = "person";
    await refresh(workflowA, firstSubject, "A 更正");
    const current = await workflowA.inspectCurrentCatalogueEntity(
      "reevaluation-persona",
    );
    expect(current?.entity.kind).toEqual({
      status: "conflict",
      kinds: expect.arrayContaining(["person", "persona"]),
    });
    const relatedKindsInCatalogue = async () =>
      (
        (await workflowA.inspect(first.execution.id)).accepted
          ?.currentRelatedEntities ?? []
      )
        .filter((entity) => entity.id === "reevaluation-persona")
        .map((entity) => entity.kind);
    expect(await relatedKindsInCatalogue()).toEqual(
      expect.arrayContaining([
        {
          status: "conflict",
          kinds: expect.arrayContaining(["person", "persona"]),
        },
      ]),
    );
    const override = await workflowA.previewEntityKindDecision({
      entityId: "reevaluation-persona",
      selectedKind: "person",
    });
    await expect(
      workflowA.applyEntityKindDecision({
        entityId: "reevaluation-persona",
        selectedKind: "person",
        actorId: "user:甲",
        baseline: override.baseline,
      }),
    ).resolves.toBe("applied");
    await expect(
      workflowA.inspectCurrentCatalogueEntity("reevaluation-persona"),
    ).resolves.toMatchObject({
      entity: { kind: { status: "effective", kind: "person" } },
    });
    expect(await relatedKindsInCatalogue()).toEqual(
      expect.arrayContaining([
        { status: "effective", kind: "person", basis: "decision" },
      ]),
    );
    const clear = await workflowA.previewEntityKindDecision({
      entityId: "reevaluation-persona",
    });
    await expect(
      workflowA.applyEntityKindDecision({
        entityId: "reevaluation-persona",
        actorId: "user:甲",
        baseline: clear.baseline,
      }),
    ).resolves.toBe("applied");
    await expect(
      workflowA.inspectCurrentCatalogueEntity("reevaluation-persona"),
    ).resolves.toMatchObject({
      entity: {
        kind: {
          status: "conflict",
          kinds: expect.arrayContaining(["person", "persona"]),
        },
      },
    });
    expect(await relatedKindsInCatalogue()).toEqual(
      expect.arrayContaining([
        {
          status: "conflict",
          kinds: expect.arrayContaining(["person", "persona"]),
        },
      ]),
    );
    a.omitPersona = true;
    const completeMissing = await refresh(
      workflowA,
      firstSubject,
      "A 完整缺失",
    );
    const completeMissingRun = completeMissing.sourceRefreshRuns?.[0];
    expect(completeMissingRun).toMatchObject({
      phase: "reviewing",
      changeSets: [{ disposition: "pending" }],
    });
    await expect(
      workflowA.reviewSourceRefreshChangeSet({
        runId: completeMissingRun!.id,
        changeSetId: completeMissingRun!.changeSets[0]!.id,
        disposition: "approved",
      }),
    ).resolves.toMatchObject({ phase: "terminal", outcome: "succeeded" });
    await expect(
      workflowA.inspectCurrentCatalogueEntity("reevaluation-persona"),
    ).resolves.toMatchObject({
      entity: { kind: { status: "effective", kind: "persona" } },
    });
    b.omitPersona = true;
    b.sourceCompleteness = "incomplete";
    const incompleteMissing = await refresh(
      workflowB,
      secondSubject,
      "B 不完整缺失",
    );
    expect(incompleteMissing.sourceRefreshRuns).toMatchObject([
      {
        changeSets: [
          {
            changes: expect.arrayContaining([
              expect.objectContaining({ kind: "unchanged" }),
            ]),
          },
        ],
      },
    ]);
    await expect(
      workflowB.inspectCurrentCatalogueEntity("reevaluation-persona"),
    ).resolves.toMatchObject({
      entity: { kind: { status: "effective", kind: "persona" } },
    });
    b.sourceCompleteness = undefined;
    b.omitPersona = false;
    b.personaKind = "person";
    await refresh(workflowB, secondSubject, "B 更正");
    await expect(
      workflowB.inspectCurrentCatalogueEntity("reevaluation-persona"),
    ).resolves.toMatchObject({
      entity: { kind: { status: "effective", kind: "person" } },
    });
    catalogue.close();
    const reopened = SqliteCatalogue.forProductData(root);
    const reopenedWorkflow = reevaluationWorkflow(reopened, b);
    await expect(
      reopenedWorkflow.inspectCurrentCatalogueEntity("reevaluation-persona"),
    ).resolves.toMatchObject({
      entity: { kind: { status: "effective", kind: "person" } },
    });
    reopened.close();
  });

  it("keeps review-gated public metadata refresh in the same durable Change Set path", async () => {
    const catalogue = await createCatalogue();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-review",
      executionId: "source-refresh-review-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();

    const awaitingReview = await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: current!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    expect(awaitingReview.execution).toMatchObject({
      status: "running",
      stage: "source-records-retained",
      sourceRefreshRunIds: [expect.any(String)],
    });
    expect(awaitingReview.execution.outcome).toBeUndefined();
    expect(run).toMatchObject({
      phase: "reviewing",
      changeSets: [{ disposition: "pending" }],
    });
    await expect(
      catalogue.listCurrentAttentionPage({ limit: 10 }),
    ).resolves.toMatchObject({
      items: [
        {
          kind: "source-refresh-review",
          executionId: awaitingReview.execution.id,
          assetId: current!.entity.id,
          sourceRefreshChangeSetId: run!.changeSets[0].id,
        },
      ],
    });

    await expect(
      workflow.reviewSourceRefreshChangeSet({
        runId: run!.id,
        changeSetId: run!.changeSets[0].id,
        disposition: "approved",
      }),
    ).resolves.toMatchObject({ phase: "terminal", outcome: "succeeded" });
    await expect(
      workflow.inspectSourceRefreshRun(run!.id),
    ).resolves.toMatchObject({
      phase: "terminal",
      outcome: "succeeded",
    });
    await expect(
      workflow.inspect(awaitingReview.execution.id),
    ).resolves.toMatchObject({
      execution: {
        status: "completed",
        stage: "completed",
        outcome: "accepted",
      },
      sourceRefreshRuns: [{ phase: "terminal", outcome: "succeeded" }],
    });
    expect(
      (await catalogue.listCurrentAttentionPage({ limit: 10 })).items,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRefreshChangeSetId: run!.changeSets[0].id,
        }),
      ]),
    );
  });

  it("reprojects the same waiting SQLite execution after a Change Set is rejected", async () => {
    const catalogue = await createCatalogue();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-rejection",
      executionId: "source-refresh-rejection-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();

    const awaitingReview = await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: current!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    expect(awaitingReview.execution.status).toBe("running");
    expect(
      (await catalogue.listCurrentAttentionPage({ limit: 10 })).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "source-refresh-review",
          sourceRefreshChangeSetId: run!.changeSets[0].id,
        }),
      ]),
    );

    await expect(
      workflow.reviewSourceRefreshChangeSet({
        runId: run!.id,
        changeSetId: run!.changeSets[0].id,
        disposition: "rejected",
      }),
    ).resolves.toMatchObject({ phase: "terminal", outcome: "failed" });
    await expect(
      workflow.inspect(awaitingReview.execution.id),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        stage: "failed",
        outcome: "failed",
      },
      sourceRefreshRuns: [
        {
          phase: "terminal",
          outcome: "failed",
          scopes: [{ outcome: "skipped" }],
        },
      ],
    });
    expect(
      (await catalogue.listCurrentAttentionPage({ limit: 10 })).items,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRefreshChangeSetId: run!.changeSets[0].id,
        }),
      ]),
    );
  });

  it("reprojects the same waiting SQLite execution after a Source Refresh Run is cancelled", async () => {
    const catalogue = await createCatalogue();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-cancellation",
      executionId: "source-refresh-cancellation-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();

    const awaitingReview = await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: current!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    expect(awaitingReview.execution.status).toBe("running");
    expect(
      (await catalogue.listCurrentAttentionPage({ limit: 10 })).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "source-refresh-review",
          sourceRefreshChangeSetId: run!.changeSets[0].id,
        }),
      ]),
    );

    await expect(
      workflow.cancelSourceRefreshRun(run!.id),
    ).resolves.toMatchObject({
      phase: "terminal",
      outcome: "cancelled",
    });
    await expect(
      workflow.inspect(awaitingReview.execution.id),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        stage: "failed",
        outcome: "failed",
      },
      sourceRefreshRuns: [
        {
          phase: "terminal",
          outcome: "cancelled",
          scopes: [{ outcome: "cancelled" }],
        },
      ],
    });
    expect(
      (await catalogue.listCurrentAttentionPage({ limit: 10 })).items,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRefreshChangeSetId: run!.changeSets[0].id,
        }),
      ]),
    );
  });

  it("reprojects a terminal Source Refresh Run during startup recovery", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-startup-reprojection",
      executionId: "source-refresh-startup-reprojection-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();

    const awaitingReview = await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: current!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];

    // 模拟领域转换提交后、其应用层结果尚未通过公开协调器投影前发生的重启。
    await catalogue.cancelSourceRefreshRun(run!.id);
    await expect(
      catalogue.inspectExecution(awaitingReview.execution.id),
    ).resolves.toMatchObject({
      execution: { status: "running", stage: "source-records-retained" },
      sourceRefreshRuns: [{ id: run!.id, phase: "terminal" }],
    });
    catalogue.close();

    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    const restartedWorkflow = reevaluationWorkflow(restartedCatalogue, state);
    await expect(restartedWorkflow.recoverRunningExecutions()).resolves.toEqual(
      [
        expect.objectContaining({
          execution: expect.objectContaining({
            id: awaitingReview.execution.id,
            status: "failed",
            stage: "failed",
            outcome: "failed",
          }),
          sourceRefreshRuns: [
            expect.objectContaining({
              id: run!.id,
              phase: "terminal",
              outcome: "cancelled",
            }),
          ],
        }),
      ],
    );
    restartedCatalogue.close();
  });

  it("lets concurrent startup recovery project one terminal Source Refresh Run exactly once", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-concurrent-recovery",
      executionId: "source-refresh-concurrent-recovery-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();
    const awaitingReview = await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: current!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    await catalogue.cancelSourceRefreshRun(run!.id);
    catalogue.close();

    const firstCatalogue = SqliteCatalogue.forProductData(root);
    const secondCatalogue = SqliteCatalogue.forProductData(root);
    const [firstRecovered, secondRecovered] = await Promise.all([
      reevaluationWorkflow(firstCatalogue, state).recoverRunningExecutions(),
      reevaluationWorkflow(secondCatalogue, state).recoverRunningExecutions(),
    ]);

    expect([...firstRecovered, ...secondRecovered]).toHaveLength(1);
    await expect(
      firstCatalogue.inspectExecution(awaitingReview.execution.id),
    ).resolves.toMatchObject({
      execution: { status: "failed", stage: "failed", outcome: "failed" },
      sourceRefreshRuns: [
        { id: run!.id, phase: "terminal", outcome: "cancelled" },
      ],
    });
    firstCatalogue.close();
    secondCatalogue.close();
  });

  it("reprojects the same waiting SQLite execution after approval finds a stale lineage", async () => {
    const catalogue = await createCatalogue();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-stale-review",
      executionId: "source-refresh-stale-review-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();
    const selection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [
        {
          subjectId: current!.entity.id,
          explanations: [{ path: ["selected asset"] }],
        },
      ],
      filesystemScopes: [],
    };

    const awaitingReview = await workflow.refreshMetadata({
      selection,
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    await expect(
      workflow.refreshMetadata({ selection }),
    ).resolves.toMatchObject({
      execution: {
        status: "completed",
        outcome: "accepted",
      },
    });

    await expect(
      workflow.reviewSourceRefreshChangeSet({
        runId: run!.id,
        changeSetId: run!.changeSets[0].id,
        disposition: "approved",
      }),
    ).resolves.toMatchObject({
      phase: "terminal",
      outcome: "failed",
      scopes: [{ outcome: "stale" }],
    });
    await expect(
      workflow.inspect(awaitingReview.execution.id),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        stage: "failed",
        outcome: "failed",
      },
      sourceRefreshRuns: [
        { phase: "terminal", scopes: [{ outcome: "stale" }] },
      ],
    });
  });

  it("persists an acquiring Source Refresh scope while public metadata collection is in flight", async () => {
    const catalogue = await createCatalogue();
    let releaseCollection!: () => void;
    const collectionRelease = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    let markCollectionStarted!: () => void;
    const collectionStarted = new Promise<void>((resolve) => {
      markCollectionStarted = resolve;
    });
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      collectionBarrier: undefined as (() => Promise<void>) | undefined,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-acquiring",
      executionId: "source-refresh-acquiring-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();
    state.collectionBarrier = async () => {
      markCollectionStarted();
      await collectionRelease;
    };
    let refreshExecutionId: string | undefined;
    const refreshing = workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: current!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      onExecutionStarted(execution) {
        refreshExecutionId = execution.id;
      },
    });

    await collectionStarted;
    await expect(workflow.inspect(refreshExecutionId!)).resolves.toMatchObject({
      execution: { status: "running" },
      sourceRefreshRuns: [
        {
          phase: "acquiring",
          scopes: [{ state: "acquiring", acquisitionAttempt: 1 }],
        },
      ],
    });
    releaseCollection();
    await expect(refreshing).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
      sourceRefreshRuns: [{ phase: "terminal", outcome: "succeeded" }],
    });
  });

  it("does not submit a collector result after a concurrent Source Refresh cancellation", async () => {
    const catalogue = await createCatalogue();
    let releaseCollection!: () => void;
    const collectionRelease = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    let markCollectionStarted!: () => void;
    const collectionStarted = new Promise<void>((resolve) => {
      markCollectionStarted = resolve;
    });
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      collectionBarrier: undefined as (() => Promise<void>) | undefined,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-cancel-in-flight",
      executionId: "source-refresh-cancel-in-flight-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();
    state.collectionBarrier = async () => {
      markCollectionStarted();
      await collectionRelease;
    };
    let refreshExecutionId: string | undefined;
    const refreshing = workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: current!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      onExecutionStarted(execution) {
        refreshExecutionId = execution.id;
      },
    });

    await collectionStarted;
    const run = (await workflow.inspect(refreshExecutionId!))
      ?.sourceRefreshRuns?.[0];
    expect(run).toMatchObject({ phase: "acquiring" });
    await expect(
      workflow.cancelSourceRefreshRun(run!.id),
    ).resolves.toMatchObject({
      phase: "terminal",
      outcome: "cancelled",
    });
    releaseCollection();

    await expect(refreshing).resolves.toMatchObject({
      execution: { status: "failed", stage: "failed", outcome: "failed" },
      sourceRecords: [],
      sourceRefreshRuns: [{ phase: "terminal", outcome: "cancelled" }],
    });
    await expect(workflow.inspect(refreshExecutionId!)).resolves.toMatchObject({
      execution: { status: "failed", stage: "failed", outcome: "failed" },
      sourceRecords: [],
      sourceRefreshRuns: [{ phase: "terminal", outcome: "cancelled" }],
    });
  });

  it("commits a successful scope when the same collector reports another refresh scope failed", async () => {
    const catalogue = await createCatalogue();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      partialSourceRefreshFailure: false,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-partial-coverage",
      executionId: "source-refresh-partial-coverage-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();

    state.partialSourceRefreshFailure = true;
    const refreshed = await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: current!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
    });

    expect(refreshed).toMatchObject({
      execution: { status: "completed", outcome: "partially-succeeded" },
      sourceRecords: [{ coverage: { id: "reevaluation.title" } }],
      sourceRefreshRuns: [
        {
          phase: "terminal",
          outcome: "partially-succeeded",
          scopes: [
            {
              coverage: { coverageId: "reevaluation.title" },
              outcome: "applied",
            },
            {
              coverage: { coverageId: "reevaluation.description" },
              outcome: "failed",
            },
          ],
        },
      ],
    });
    const accepted = await catalogue.findAcceptedForSubjects([
      current!.entity.id,
    ]);
    expect(accepted[0]?.accepted.metadata).toContainEqual(
      expect.objectContaining({
        property: "asset.title",
        value: "Reevaluation title 2",
      }),
    );
  });

  it("starts an ordinary new metadata refresh after a terminal partial Source Refresh Run", async () => {
    const catalogue = await createCatalogue();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      partialSourceRefreshFailure: false,
      partialSourceRefreshRetry: false,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-public-retry",
      executionId: "source-refresh-public-retry-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();
    const selection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [
        {
          subjectId: current!.entity.id,
          explanations: [{ path: ["selected asset"] }],
        },
      ],
      filesystemScopes: [],
    };

    state.partialSourceRefreshFailure = true;
    const predecessorExecution = await workflow.refreshMetadata({ selection });
    const predecessor = predecessorExecution.sourceRefreshRuns?.[0];
    expect(predecessor).toMatchObject({
      phase: "terminal",
      outcome: "partially-succeeded",
      scopes: [
        { coverage: { coverageId: "reevaluation.title" }, outcome: "applied" },
        {
          coverage: { coverageId: "reevaluation.description" },
          outcome: "failed",
        },
      ],
    });

    state.partialSourceRefreshFailure = false;
    const refreshed = await workflow.refreshMetadata({
      selection,
      initiatedBy: "operator-new-refresh",
    });

    expect(refreshed.execution).toMatchObject({
      status: "completed",
      outcome: "accepted",
    });
    expect(refreshed.execution.id).not.toBe(predecessorExecution.execution.id);
    expect(refreshed.sourceRefreshRuns).toMatchObject([
      {
        initiatedBy: "operator-new-refresh",
        phase: "terminal",
        outcome: "succeeded",
        scopes: [
          {
            coverage: { coverageId: "reevaluation.complete" },
            outcome: "applied",
          },
        ],
      },
    ]);
    await expect(
      workflow.inspect(predecessorExecution.execution.id),
    ).resolves.toMatchObject({
      execution: {
        id: predecessorExecution.execution.id,
        outcome: "partially-succeeded",
      },
      sourceRefreshRuns: [
        {
          id: predecessor!.id,
          phase: "terminal",
          outcome: "partially-succeeded",
        },
      ],
    });
  });

  it("advances Source Refresh lineage without superseding identical normalized metadata or relationships", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      stableSourceFacts: false,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-normalized-facts",
      executionId: "source-refresh-normalized-facts-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();
    const selection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [
        {
          subjectId: current!.entity.id,
          explanations: [{ path: ["selected asset"] }],
        },
      ],
      filesystemScopes: [],
    };

    state.stableSourceFacts = true;
    const firstStable = await workflow.refreshMetadata({ selection });
    expect(firstStable).toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
    });
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const count = (table: string) =>
      (
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          readonly count: number;
        }
      ).count;
    const before = {
      metadata: count("metadata_assertions"),
      metadataLifecycles: count("metadata_assertion_lifecycles"),
      relationships: count("entity_relationships"),
      relationshipLifecycles: count("relationship_lifecycles"),
    };

    const repeated = await workflow.refreshMetadata({ selection });
    const stableRecordIds = [
      firstStable.sourceRecords[0].id,
      repeated.sourceRecords[0].id,
    ].toSorted((left, right) => left.localeCompare(right));
    const stableRelationshipRecordIds = [
      initial.sourceRecords[0].id,
      ...stableRecordIds,
    ].toSorted((left, right) => left.localeCompare(right));
    const after = {
      metadata: count("metadata_assertions"),
      metadataLifecycles: count("metadata_assertion_lifecycles"),
      relationships: count("entity_relationships"),
      relationshipLifecycles: count("relationship_lifecycles"),
    };
    const lineage = database
      .prepare(
        `SELECT source_record_id FROM source_lineage_heads
         WHERE subject_id = ? AND source_identity = ? AND native_address = ?
           AND coverage_id = ?`,
      )
      .get(
        current!.entity.id,
        "reevaluation-source",
        "opaque:reevaluation-work",
        "reevaluation.complete",
      ) as { readonly source_record_id: string } | undefined;
    const metadataProvenanceCount = (
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM metadata_assertion_sources provenance
           JOIN metadata_assertion_lifecycles lifecycle
             ON lifecycle.assertion_id = provenance.assertion_id
           WHERE lifecycle.source_slot = ?`,
        )
        .get("reevaluation.title") as { readonly count: number }
    ).count;
    const relationshipProvenanceCount = (
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM relationship_sources provenance
           JOIN relationship_lifecycles lifecycle
             ON lifecycle.relationship_id = provenance.relationship_id
           WHERE lifecycle.source_slot = ?`,
        )
        .get("reevaluation.credit.voice") as { readonly count: number }
    ).count;
    database.close();

    expect(repeated).toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
      sourceRefreshRuns: [
        {
          phase: "terminal",
          outcome: "succeeded",
          changeSets: [{ changes: [] }],
        },
      ],
    });
    expect(after).toEqual(before);
    expect(lineage?.source_record_id).toBe(repeated.sourceRecords[0]?.id);
    expect(metadataProvenanceCount).toBe(3);
    expect(relationshipProvenanceCount).toBe(3);

    const [projected] = await catalogue.findAcceptedForSubjects([
      current!.entity.id,
    ]);
    expect(
      projected?.accepted.metadata.find(
        ({ sourceSlot }) => sourceSlot === "reevaluation.title",
      )?.sourceRecordIds,
    ).toEqual(stableRecordIds);
    expect(
      projected?.accepted.relationships?.find(
        ({ sourceSlot }) => sourceSlot === "reevaluation.credit.voice",
      )?.sourceRecordIds,
    ).toEqual(stableRelationshipRecordIds);

    catalogue.close();
    const reopened = SqliteCatalogue.forProductData(root);
    const [reopenedProjection] = await reopened.findAcceptedForSubjects([
      current!.entity.id,
    ]);
    expect(
      reopenedProjection?.accepted.metadata.find(
        ({ sourceSlot }) => sourceSlot === "reevaluation.title",
      )?.sourceRecordIds,
    ).toEqual(stableRecordIds);
    expect(
      reopenedProjection?.accepted.relationships?.find(
        ({ sourceSlot }) => sourceSlot === "reevaluation.credit.voice",
      )?.sourceRecordIds,
    ).toEqual(stableRelationshipRecordIds);
    reopened.close();
  });

  it("keeps sourced-subject facts unchanged after their first public Source Refresh adoption", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      stableSourceFacts: false,
      sourceResolvedSubject: undefined as "alpha" | "beta" | undefined,
      reverseSourceResolvedSubjectQualifiers: false,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-sourced-subject",
      executionId: "source-refresh-sourced-subject-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();
    const selection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [
        {
          subjectId: current!.entity.id,
          explanations: [{ path: ["selected asset"] }],
        },
      ],
      filesystemScopes: [],
    };

    state.stableSourceFacts = true;
    state.sourceResolvedSubject = "alpha";
    const adopted = await workflow.refreshMetadata({ selection });
    expect(adopted).toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
      sourceRefreshRuns: [{ phase: "terminal", outcome: "succeeded" }],
    });
    expect(adopted.sourceRefreshRuns?.[0]?.changeSets[0]?.changes).toEqual(
      expect.arrayContaining([
        {
          kind: "established",
          factReference: "metadata:entity.display-name",
        },
        {
          kind: "established",
          factReference:
            "relationship:entity.association:reevaluation.source-subject.association",
        },
      ]),
    );

    const sourceSubjectId = "reevaluation-source-subject-alpha";
    const subjectFactCounts = () => {
      const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
      const count = (statement: string) =>
        (
          database.prepare(statement).get(sourceSubjectId) as {
            readonly count: number;
          }
        ).count;
      const counts = {
        metadata: count(
          "SELECT COUNT(*) AS count FROM metadata_assertions WHERE subject_id = ?",
        ),
        metadataLifecycles: count(
          `SELECT COUNT(*) AS count
           FROM metadata_assertion_lifecycles lifecycle
           JOIN metadata_assertions assertion ON assertion.id = lifecycle.assertion_id
           WHERE assertion.subject_id = ?`,
        ),
        relationships: count(
          `SELECT COUNT(*) AS count
           FROM relationship_lifecycles lifecycle
           WHERE lifecycle.source_subject_id = ?`,
        ),
        relationshipLifecycles: count(
          `SELECT COUNT(*) AS count
           FROM relationship_lifecycles lifecycle
           JOIN entity_relationships relationship ON relationship.id = lifecycle.relationship_id
           WHERE lifecycle.source_subject_id = ?`,
        ),
      };
      database.close();
      return counts;
    };
    const before = subjectFactCounts();

    state.reverseSourceResolvedSubjectQualifiers = true;
    const repeated = await workflow.refreshMetadata({ selection });
    const after = subjectFactCounts();
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const lineage = database
      .prepare(
        `SELECT source_record_id FROM source_lineage_heads
         WHERE subject_id = ? AND source_identity = ? AND native_address = ?
           AND coverage_id = ?`,
      )
      .get(
        current!.entity.id,
        "reevaluation-source",
        "opaque:reevaluation-work",
        "reevaluation.complete",
      ) as { readonly source_record_id: string } | undefined;
    database.close();

    expect(before).toEqual({
      metadata: 1,
      metadataLifecycles: 1,
      relationships: 1,
      relationshipLifecycles: 1,
    });
    expect(repeated).toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
      sourceRefreshRuns: [
        {
          phase: "terminal",
          outcome: "succeeded",
          changeSets: [{ changes: [] }],
        },
      ],
    });
    expect(after).toEqual(before);
    expect(lineage?.source_record_id).toBe(repeated.sourceRecords[0]?.id);
  });

  it("holds complete sourced-subject omissions for review before retracting their current facts", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      stableSourceFacts: false,
      sourceResolvedSubject: undefined as "alpha" | "beta" | undefined,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-sourced-subject-retraction",
      executionId: "source-refresh-sourced-subject-retraction-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();
    const selection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [
        {
          subjectId: current!.entity.id,
          explanations: [{ path: ["selected asset"] }],
        },
      ],
      filesystemScopes: [],
    };

    state.stableSourceFacts = true;
    state.sourceResolvedSubject = "alpha";
    await workflow.refreshMetadata({ selection });

    const sourceSubjectId = "reevaluation-source-subject-alpha";
    const currentFactCounts = () => {
      const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
      const count = (statement: string) =>
        (
          database.prepare(statement).get(sourceSubjectId) as {
            readonly count: number;
          }
        ).count;
      const counts = {
        metadata: count(
          `SELECT COUNT(*) AS count FROM metadata_assertions assertion
           WHERE assertion.subject_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM metadata_assertion_lifecycles successor
               WHERE successor.predecessor_assertion_id = assertion.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM metadata_assertion_retractions retraction
               WHERE retraction.assertion_id = assertion.id
             )`,
        ),
        relationships: count(
          `SELECT COUNT(*) AS count FROM entity_relationships relationship
           JOIN relationship_lifecycles lifecycle
             ON lifecycle.relationship_id = relationship.id
           WHERE lifecycle.source_subject_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM relationship_lifecycles successor
               WHERE successor.predecessor_relationship_id = relationship.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM relationship_retractions retraction
               WHERE retraction.relationship_id = relationship.id
             )`,
        ),
      };
      database.close();
      return counts;
    };
    expect(currentFactCounts()).toEqual({ metadata: 1, relationships: 1 });

    state.sourceResolvedSubject = undefined;
    const awaitingReview = await workflow.refreshMetadata({ selection });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    expect(awaitingReview.execution).toMatchObject({
      status: "running",
      stage: "source-records-retained",
    });
    expect(run).toMatchObject({
      phase: "reviewing",
      changeSets: [
        {
          requiresReview: true,
          disposition: "pending",
          changes: expect.arrayContaining([
            {
              kind: "retracted",
              factReference:
                "metadata-slot:reevaluation-source-subject-alpha:reevaluation.source-subject.name",
            },
            {
              kind: "retracted",
              factReference:
                "relationship-slot:reevaluation-source-subject-alpha:reevaluation.source-subject.association",
            },
          ]),
        },
      ],
    });
    expect(currentFactCounts()).toEqual({ metadata: 1, relationships: 1 });

    await expect(
      workflow.reviewSourceRefreshChangeSet({
        runId: run!.id,
        changeSetId: run!.changeSets[0].id,
        disposition: "approved",
      }),
    ).resolves.toMatchObject({ phase: "terminal", outcome: "succeeded" });
    await expect(
      workflow.inspect(awaitingReview.execution.id),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
      sourceRefreshRuns: [{ phase: "terminal", outcome: "succeeded" }],
    });
    expect(currentFactCounts()).toEqual({ metadata: 0, relationships: 0 });
  });

  it("treats root and sourced-subject source slots as distinct refresh coordinates", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
      sourceRefreshAuthority: true,
      stableSourceFacts: true,
      sourceResolvedSubject: "root" as "root" | "alpha" | "beta",
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/source-refresh-subject-coordinate",
      executionId: "source-refresh-subject-coordinate-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))
      ?.accepted;
    expect(current).toBeDefined();
    const selection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [
        {
          subjectId: current!.entity.id,
          explanations: [{ path: ["selected asset"] }],
        },
      ],
      filesystemScopes: [],
    };
    const currentSlotFacts = (subjectId: string) => {
      const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
      const count = (statement: string) =>
        (
          database.prepare(statement).get(subjectId) as {
            readonly count: number;
          }
        ).count;
      const facts = {
        metadata: count(
          `SELECT COUNT(*) AS count
           FROM metadata_assertion_lifecycles lifecycle
           JOIN metadata_assertions assertion ON assertion.id = lifecycle.assertion_id
           WHERE assertion.subject_id = ?
             AND lifecycle.source_slot = 'reevaluation.source-subject.name'
             AND NOT EXISTS (
               SELECT 1 FROM metadata_assertion_lifecycles successor
               WHERE successor.predecessor_assertion_id = assertion.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM metadata_assertion_retractions retraction
               WHERE retraction.assertion_id = assertion.id
             )`,
        ),
        relationships: count(
          `SELECT COUNT(*) AS count
           FROM relationship_lifecycles lifecycle
           JOIN entity_relationships relationship ON relationship.id = lifecycle.relationship_id
           WHERE lifecycle.source_subject_id = ?
             AND lifecycle.source_slot = 'reevaluation.source-subject.association'
             AND NOT EXISTS (
               SELECT 1 FROM relationship_lifecycles successor
               WHERE successor.predecessor_relationship_id = relationship.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM relationship_retractions retraction
               WHERE retraction.relationship_id = relationship.id
             )`,
        ),
      };
      database.close();
      return facts;
    };
    const approve = async (
      run: NonNullable<
        Awaited<
          ReturnType<typeof workflow.refreshMetadata>
        >["sourceRefreshRuns"]
      >[number],
    ) =>
      await workflow.reviewSourceRefreshChangeSet({
        runId: run.id,
        changeSetId: run.changeSets[0].id,
        disposition: "approved",
      });

    expect(currentSlotFacts(current!.entity.id)).toEqual({
      metadata: 1,
      relationships: 1,
    });

    state.sourceResolvedSubject = "alpha";
    const rootToAlpha = await workflow.refreshMetadata({ selection });
    const rootToAlphaRun = rootToAlpha.sourceRefreshRuns?.[0];
    expect(rootToAlphaRun).toMatchObject({
      phase: "reviewing",
      changeSets: [
        {
          requiresReview: true,
          changes: expect.arrayContaining([
            {
              kind: "established",
              factReference: "metadata:entity.display-name",
            },
            {
              kind: "established",
              factReference:
                "relationship:entity.association:reevaluation.source-subject.association",
            },
            {
              kind: "retracted",
              factReference: "metadata-slot:reevaluation.source-subject.name",
            },
            {
              kind: "retracted",
              factReference:
                "relationship-slot:reevaluation.source-subject.association",
            },
          ]),
        },
      ],
    });
    expect(rootToAlphaRun?.changeSets[0]?.changes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "superseded" })]),
    );
    await expect(approve(rootToAlphaRun!)).resolves.toMatchObject({
      phase: "terminal",
      outcome: "succeeded",
    });
    expect(currentSlotFacts(current!.entity.id)).toEqual({
      metadata: 0,
      relationships: 0,
    });
    expect(currentSlotFacts("reevaluation-source-subject-alpha")).toEqual({
      metadata: 1,
      relationships: 1,
    });

    state.sourceResolvedSubject = "beta";
    const alphaToBeta = await workflow.refreshMetadata({ selection });
    const alphaToBetaRun = alphaToBeta.sourceRefreshRuns?.[0];
    expect(alphaToBetaRun).toMatchObject({
      phase: "reviewing",
      changeSets: [
        {
          requiresReview: true,
          changes: expect.arrayContaining([
            {
              kind: "established",
              factReference: "metadata:entity.display-name",
            },
            {
              kind: "established",
              factReference:
                "relationship:entity.association:reevaluation.source-subject.association",
            },
            {
              kind: "retracted",
              factReference:
                "metadata-slot:reevaluation-source-subject-alpha:reevaluation.source-subject.name",
            },
            {
              kind: "retracted",
              factReference:
                "relationship-slot:reevaluation-source-subject-alpha:reevaluation.source-subject.association",
            },
          ]),
        },
      ],
    });
    expect(alphaToBetaRun?.changeSets[0]?.changes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "superseded" })]),
    );
    await expect(approve(alphaToBetaRun!)).resolves.toMatchObject({
      phase: "terminal",
      outcome: "succeeded",
    });
    expect(currentSlotFacts("reevaluation-source-subject-alpha")).toEqual({
      metadata: 0,
      relationships: 0,
    });
    expect(currentSlotFacts("reevaluation-source-subject-beta")).toEqual({
      metadata: 1,
      relationships: 1,
    });

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      database
        .prepare(
          `SELECT lifecycle.predecessor_assertion_id
           FROM metadata_assertion_lifecycles lifecycle
           JOIN metadata_assertions assertion ON assertion.id = lifecycle.assertion_id
           WHERE assertion.subject_id = ?
             AND lifecycle.source_slot = 'reevaluation.source-subject.name'`,
        )
        .get("reevaluation-source-subject-beta"),
    ).toEqual({ predecessor_assertion_id: null });
    expect(
      database
        .prepare(
          `SELECT lifecycle.predecessor_relationship_id
           FROM relationship_lifecycles lifecycle
           JOIN entity_relationships relationship ON relationship.id = lifecycle.relationship_id
           WHERE lifecycle.source_subject_id = ?
             AND lifecycle.source_slot = 'reevaluation.source-subject.association'`,
        )
        .get("reevaluation-source-subject-beta"),
    ).toEqual({ predecessor_relationship_id: null });
    database.close();
  });

  it("keeps a legacy accepted boundary when a later workflow declares it explicitly", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
      explicitPlan: false,
    };
    const workflow = reevaluationWorkflow(catalogue, state);

    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/legacy-boundary",
      executionId: "legacy-boundary-initial",
      acceptTrusted: true,
    });
    const current = (await catalogue.inspectExecution(initial.execution.id))!
      .accepted!;
    await expect(
      catalogue.findAcceptedForWorkItem({
        directory: "/observed/legacy-boundary",
        relativePaths: ["work.bin"],
      }),
    ).resolves.toMatchObject({
      accepted: { entity: { id: current.entity.id } },
    });

    state.observationVersion = 1;
    state.explicitPlan = true;
    const reevaluated = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/legacy-boundary",
      executionId: "legacy-boundary-explicit-reevaluation",
      acceptTrusted: true,
    });

    expect(reevaluated.execution.workItems).toEqual([
      expect.objectContaining({
        key: "work",
        outcome: "accepted",
        acceptedAssetId: current.entity.id,
      }),
    ]);
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    for (const [table, predicate] of [
      ["entity_kind_assertions", "kind = 'digital-asset'"],
      ["source_associations", "1 = 1"],
      ["recognition_decisions", "1 = 1"],
    ]) {
      expect(
        (
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`,
            )
            .get() as { readonly count: number }
        ).count,
      ).toBe(1);
    }
    database.close();
  });

  it("does not recover an incomplete legacy snapshot as a complete work-item boundary after SQLite restart", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const current = accepted();
    const initial: WorkflowExecution = {
      ...execution(),
      id: "legacy-incomplete-boundary",
      snapshot: {
        ...execution().snapshot!,
        complete: false,
        files: [
          {
            relativePath: "work.bin",
            size: 4,
            modifiedAt: "2026-07-30T00:00:00.000Z",
          },
        ],
      },
    };
    await catalogue.createExecution(initial);
    await retainSourceRecords(catalogue, initial.id, [
      {
        id: "record",
        sourceIdentity: "source",
        nativeAddress: "https://source.example/work",
        mediaType: "application/json",
        acquiredAt: "2026-07-30T00:00:00.000Z",
        acquisition: {
          requestedAddress: "https://source.example/work.json",
          method: "GET",
          authorized: false,
        },
        coverage: {
          id: "complete",
          completeness: "complete",
          authority: "official",
        },
        digest: "record-digest",
        body: "{}",
      },
    ]);
    await acceptRecognition(catalogue, {
      execution: {
        ...initial,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        acceptedAssetId: current.entity.id,
        proposalId: current.proposal.id,
      },
      accepted: current,
    });
    catalogue.close();

    const later = SqliteCatalogue.forProductData(root);
    await expect(
      later.findAcceptedForWorkItem({
        directory: "/observed",
        relativePaths: ["work.bin"],
      }),
    ).resolves.toBeUndefined();
    later.close();
  });

  it("reacquires a missing managed artifact without reviving its predecessor association", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const requirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [{ property: "asset.title", necessity: "required" as const }],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "required" as const,
          maximum: 1,
        },
      ],
      relationshipTypes: [],
    };
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/missing-managed",
      executionId: "missing-managed-initial",
      acceptTrusted: true,
      informationRequirement: requirement,
    });
    expect(initial.execution.outcome).toBe("accepted");
    const initialAccepted = (await catalogue.inspectExecution(
      initial.execution.id,
    ))!.workItemInspections![0].accepted!;
    const predecessor = initialAccepted.artifactAssociations.find(
      (association) => association.role === "asset.primary-cover",
    )!;
    expect(
      await catalogue.findAcceptedForWorkItem({
        directory: "/observed/missing-managed",
        relativePaths: ["work.bin"],
      }),
    ).toBeDefined();
    state.managedMissing = true;

    const refreshed = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/missing-managed",
      executionId: "missing-managed-reevaluation",
      acceptTrusted: true,
      informationRequirement: requirement,
    });

    expect(refreshed.execution.workItems?.[0]?.reason).toBeUndefined();
    expect(refreshed.execution.outcome).toBe("accepted");
    expect(state.sourceVersion).toBe(2);
    const refreshedAccepted = (await catalogue.inspectExecution(
      refreshed.execution.id,
    ))!.workItemInspections![0].accepted!;
    const successor = refreshedAccepted.artifactAssociations.find(
      (association) => association.role === "asset.primary-cover",
    )!;
    expect(successor.id).not.toBe(predecessor.id);
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const associationLifecycle =
      database
        .prepare(
          `SELECT successor_association_id
           FROM artifact_association_supersessions
           WHERE predecessor_association_id = ?`,
        )
        .get(predecessor.id) ??
      database
        .prepare(
          `SELECT id FROM artifact_association_retractions
           WHERE association_id = ?`,
        )
        .get(predecessor.id);
    expect(associationLifecycle).toBeDefined();
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM artifact_associations aa
           WHERE aa.role = 'asset.primary-cover'
             AND NOT EXISTS (
               SELECT 1 FROM artifact_association_supersessions s
               WHERE s.predecessor_association_id = aa.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM artifact_association_retractions r
               WHERE r.association_id = aa.id
             )`,
        )
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("retracts an absent source-owned cover with the complete reevaluation record, not its old decision", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
    };
    const workflow = reevaluationWorkflow(catalogue, state);
    const initial = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/retraction-provenance",
      executionId: "retraction-provenance-initial",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.title", necessity: "required" }],
        artifactRoles: [
          {
            role: "asset.primary-cover",
            necessity: "required",
            maximum: 1,
          },
        ],
        relationshipTypes: [],
      },
    });
    const previous = (await catalogue.inspectExecution(initial.execution.id))!
      .workItemInspections![0].accepted!;
    const predecessor = previous.artifactAssociations.find(
      (association) => association.role === "asset.primary-cover",
    )!;

    state.observationVersion = 1;
    state.omitCover = true;
    const refreshed = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed/retraction-provenance",
      executionId: "retraction-provenance-refresh",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.title", necessity: "required" }],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });

    expect(refreshed.execution.outcome).toBe("accepted");
    const current = (await catalogue.inspectExecution(refreshed.execution.id))!
      .workItemInspections![0].accepted!;
    expect(
      current.artifactAssociations.some(
        (association) => association.id === predecessor.id,
      ),
    ).toBe(false);
    expect(current.recognitionDecision).toEqual(previous.recognitionDecision);

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      database
        .prepare(
          `SELECT proposal_id, source_record_ids_json, recognition_decision_id
           FROM artifact_association_retractions WHERE association_id = ?`,
        )
        .get(predecessor.id),
    ).toEqual({
      proposal_id: refreshed.execution.workItems![0].proposalId,
      source_record_ids_json: JSON.stringify([
        `reevaluation-record-${state.sourceVersion}`,
      ]),
      recognition_decision_id: null,
    });
    expect(
      database
        .prepare(
          `SELECT successor_association_id
           FROM artifact_association_supersessions
           WHERE predecessor_association_id = ?`,
        )
        .get(predecessor.id),
    ).toBeUndefined();
    expect(
      database
        .prepare(`SELECT proposal_id FROM recognition_decisions WHERE id = ?`)
        .get(previous.recognitionDecision.id),
    ).toEqual({ proposal_id: previous.recognitionDecision.proposalId });
    database.close();
  });

  it("retracts an absent cover only with complete records from its provenance lineage", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const record = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/endpoint",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "initial-digest",
      body: "{}",
    };
    const predecessorCoverRecord = {
      ...record,
      id: "predecessor-cover-record",
      coverage: {
        id: "cover",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "predecessor-cover-digest",
    };
    const initiallyAccepted: AcceptedRecognition = {
      ...accepted(),
      proposal: {
        ...accepted().proposal,
        basis: {
          kind: "source-interpretation",
          interpretation: {
            ...accepted().proposal.basis.interpretation,
            sourceRecordIds: [record.id, predecessorCoverRecord.id],
          },
        },
      },
      artifactAssociations: [
        {
          ...accepted().artifactAssociations[0],
          sourceRecordIds: [predecessorCoverRecord.id],
        },
      ],
    };
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [
      record,
      predecessorCoverRecord,
    ]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: initiallyAccepted,
    });
    const current = (await catalogue.inspectExecution("execution"))!.accepted!;
    const reevaluation = { ...execution(), id: "cover-provenance-refresh" };
    const nextCoverRecord = {
      ...predecessorCoverRecord,
      id: "next-cover-record",
      acquiredAt: "2026-07-30T00:00:00.000Z",
      digest: "next-cover-digest",
    };
    const unrelatedIncompleteRecord = {
      ...record,
      id: "unrelated-incomplete-record",
      acquiredAt: "2026-07-30T00:00:00.000Z",
      coverage: {
        id: "other",
        completeness: "incomplete" as const,
        authority: "official" as const,
      },
      digest: "unrelated-incomplete-digest",
    };
    await catalogue.createExecution(reevaluation);
    const expectedLineageHeads = await catalogue.freezeSourceLineageHeads({
      assetId: current.entity.id,
      sourceAssociation: current.recognitionSourceAssociation,
      coverageIds: ["cover", "other"],
    });
    await retainSourceRecords(catalogue, reevaluation.id, [
      nextCoverRecord,
      unrelatedIncompleteRecord,
    ]);
    const refreshed: AcceptedRecognition = {
      ...current,
      proposal: {
        ...current.proposal,
        id: "cover-provenance-proposal",
        basis: {
          kind: "source-interpretation",
          interpretation: {
            ...current.proposal.basis.interpretation,
            id: "cover-provenance-interpretation",
            sourceRecordIds: [nextCoverRecord.id, unrelatedIncompleteRecord.id],
            metadata: [
              {
                property: "asset.title",
                sourceSlot: "source.title",
                value: "Cover provenance refresh",
                sourceRecordIds: [nextCoverRecord.id],
              },
            ],
            sourceArtifacts: [],
            entities: [],
            entityMentions: [],
            entityResolutionDecisions: [],
            relationships: [],
          },
        },
      },
      metadata: [
        {
          target: { kind: "entity", entityId: current.entity.id },
          property: "asset.title",
          sourceSlot: "source.title",
          value: "Cover provenance refresh",
          sourceRecordIds: [nextCoverRecord.id],
        },
      ],
      entities: [],
      entityMentions: [],
      entityResolutionDecisions: [],
      relationships: [],
      artifactAssociations: [],
    };

    await catalogue.refreshAcceptedRecognition({
      expectedExecution: await executionBaseline(catalogue, reevaluation.id),
      execution: {
        ...reevaluation,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        acceptedAssetId: current.entity.id,
        proposalId: refreshed.proposal.id,
      },
      current,
      accepted: refreshed,
      sourceRecords: [nextCoverRecord, unrelatedIncompleteRecord],
      expectedLineageHeads,
    });

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      database
        .prepare(
          `SELECT source_record_ids_json FROM artifact_association_retractions
           WHERE association_id = ?`,
        )
        .get(current.artifactAssociations[0].id),
    ).toEqual({ source_record_ids_json: JSON.stringify([nextCoverRecord.id]) });
    expect(
      database
        .prepare(`SELECT proposal_id FROM recognition_decisions WHERE id = ?`)
        .get(current.recognitionDecision.id),
    ).toEqual({ proposal_id: current.recognitionDecision.proposalId });
    database.close();
  });

  it.each([
    {
      name: "only incomplete provenance coverage",
      coverage: {
        id: "cover",
        completeness: "incomplete" as const,
        authority: "official" as const,
      },
    },
    {
      name: "complete coverage from a different lineage",
      coverage: {
        id: "other-cover",
        completeness: "complete" as const,
        authority: "official" as const,
      },
    },
  ])("rolls back a cover retraction with $name", async ({ coverage }) => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const record = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/endpoint",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "initial-digest",
      body: "{}",
    };
    const predecessorCoverRecord = {
      ...record,
      id: "predecessor-cover-record",
      coverage: {
        id: "cover",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "predecessor-cover-digest",
    };
    const initiallyAccepted: AcceptedRecognition = {
      ...accepted(),
      proposal: {
        ...accepted().proposal,
        basis: {
          kind: "source-interpretation",
          interpretation: {
            ...accepted().proposal.basis.interpretation,
            sourceRecordIds: [record.id, predecessorCoverRecord.id],
          },
        },
      },
      artifactAssociations: [
        {
          ...accepted().artifactAssociations[0],
          sourceRecordIds: [predecessorCoverRecord.id],
        },
      ],
    };
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [
      record,
      predecessorCoverRecord,
    ]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: initiallyAccepted,
    });
    const current = (await catalogue.inspectExecution("execution"))!.accepted!;
    const reevaluation = { ...execution(), id: `retraction-${coverage.id}` };
    const invalidRecord = {
      ...predecessorCoverRecord,
      id: `invalid-${coverage.id}`,
      acquiredAt: "2026-07-30T00:00:00.000Z",
      coverage,
      digest: `invalid-${coverage.id}-digest`,
    };
    await catalogue.createExecution(reevaluation);
    const expectedLineageHeads = await catalogue.freezeSourceLineageHeads({
      assetId: current.entity.id,
      sourceAssociation: current.recognitionSourceAssociation,
      coverageIds: [coverage.id],
    });
    await retainSourceRecords(catalogue, reevaluation.id, [invalidRecord]);
    const refreshed: AcceptedRecognition = {
      ...current,
      proposal: {
        ...current.proposal,
        id: `invalid-retraction-proposal-${coverage.id}`,
        basis: {
          kind: "source-interpretation",
          interpretation: {
            ...current.proposal.basis.interpretation,
            id: `invalid-retraction-interpretation-${coverage.id}`,
            sourceRecordIds: [invalidRecord.id],
            metadata: [
              {
                property: "asset.title",
                sourceSlot: "source.title",
                value: "Invalid retraction refresh",
                sourceRecordIds: [invalidRecord.id],
              },
            ],
            sourceArtifacts: [],
            entities: [],
            entityMentions: [],
            entityResolutionDecisions: [],
            relationships: [],
          },
        },
      },
      metadata: [
        {
          target: { kind: "entity", entityId: current.entity.id },
          property: "asset.title",
          sourceSlot: "source.title",
          value: "Invalid retraction refresh",
          sourceRecordIds: [invalidRecord.id],
        },
      ],
      entities: [],
      entityMentions: [],
      entityResolutionDecisions: [],
      relationships: [],
      artifactAssociations: [],
    };
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const count = (table: string) =>
      (
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          readonly count: number;
        }
      ).count;
    const before = {
      proposals: count("recognition_proposals"),
      metadata: count("metadata_assertions"),
      retractions: count("artifact_association_retractions"),
      sourceRefreshChanges: count("source_refresh_changes"),
    };

    await expect(
      catalogue.refreshAcceptedRecognition({
        expectedExecution: await executionBaseline(catalogue, reevaluation.id),
        execution: {
          ...reevaluation,
          status: "completed",
          stage: "completed",
          outcome: "accepted",
          acceptedAssetId: current.entity.id,
          proposalId: refreshed.proposal.id,
        },
        current,
        accepted: refreshed,
        sourceRecords: [invalidRecord],
        expectedLineageHeads,
      }),
    ).rejects.toThrow("Artifact Association Retraction");

    expect({
      proposals: count("recognition_proposals"),
      metadata: count("metadata_assertions"),
      retractions: count("artifact_association_retractions"),
      sourceRefreshChanges: count("source_refresh_changes"),
    }).toEqual(before);
    expect(
      database
        .prepare(`SELECT proposal_id FROM recognition_decisions WHERE id = ?`)
        .get(current.recognitionDecision.id),
    ).toEqual({ proposal_id: current.recognitionDecision.proposalId });
    expect(
      database
        .prepare(`SELECT id FROM recognition_proposals WHERE id = ?`)
        .get(refreshed.proposal.id),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          `SELECT source_record_id FROM source_lineage_heads
           WHERE subject_id = ? AND coverage_id = ?`,
        )
        .get(current.entity.id, coverage.id),
    ).toEqual(
      coverage.id === "cover"
        ? { source_record_id: predecessorCoverRecord.id }
        : undefined,
    );
    database.close();
    await expect(
      catalogue.inspectExecution(reevaluation.id),
    ).resolves.toMatchObject({
      execution: { status: "running" },
    });
  });

  it("resumes a staged explicit sibling in a new catalogue instance without replaying completed or source work", async () => {
    const { root, catalogue: firstCatalogue } = await createCatalogueWithRoot();
    const state = {
      generation: randomUUID(),
      blockSecondStore: true,
      counts: {
        directory: 0,
        collect: 0,
        interpret: 0,
        recognize: 0,
        acquire: 0,
        storeSecond: 0,
      },
    };
    const requirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [{ property: "asset.title", necessity: "required" as const }],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "required" as const,
          maximum: 1,
        },
        {
          role: "asset.attachment",
          necessity: "required" as const,
          maximum: 1,
        },
      ],
      relationshipTypes: [],
    };
    const firstWorkflow = multiRecoveryWorkflow(firstCatalogue, state);
    const interrupted = scanFixtureRegisteredObservedScope(firstWorkflow, {
      directory: "/observed/multi",
      acceptTrusted: true,
      executionId: "multi-interrupted",
      informationRequirement: requirement,
    });
    let checkpoint:
      | Awaited<ReturnType<SqliteCatalogue["inspectExecution"]>>
      | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      checkpoint = await firstCatalogue.inspectExecution("multi-interrupted");
      if (
        checkpoint?.execution.workItems
          ?.find((item) => item.key === "two")
          ?.sourceArtifactAcquisitions?.some((item) =>
            item.candidateId.startsWith("two-attachment"),
          )
      )
        break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(checkpoint?.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "one", outcome: "accepted" }),
        expect.objectContaining({
          key: "two",
          proposalId: expect.any(String),
          sourceRecordIds: expect.arrayContaining([
            expect.stringContaining("product-record-two-"),
            expect.stringContaining("shared-cover-record-"),
          ]),
          sourceArtifactAcquisitions: [
            expect.objectContaining({
              candidateId: expect.stringContaining("two-attachment"),
            }),
          ],
        }),
      ]),
    );
    expect(checkpoint?.execution.selection.informationRequirement).toEqual(
      requirement,
    );
    const countsAtInterruption = { ...state.counts };
    firstCatalogue.close();

    state.generation = randomUUID();
    state.blockSecondStore = false;
    const laterCatalogue = SqliteCatalogue.forProductData(root);
    const laterWorkflow = multiRecoveryWorkflow(laterCatalogue, state);
    const resumed = await laterWorkflow.resume({
      executionId: "multi-interrupted",
      acceptTrusted: true,
    });

    expect(resumed.execution.outcome).toBe("accepted");
    expect(state.counts).toMatchObject({
      directory: countsAtInterruption.directory,
      collect: countsAtInterruption.collect,
      interpret: countsAtInterruption.interpret + 1,
      recognize: countsAtInterruption.recognize + 1,
      acquire: countsAtInterruption.acquire,
      storeSecond: 1,
    });
    const durable = await laterCatalogue.inspectExecution("multi-interrupted");
    const coverIds = durable?.workItemInspections
      ?.map((item) =>
        item.accepted?.artifactAssociations.find(
          (association) => association.role === "asset.primary-cover",
        ),
      )
      .map((association) => association?.artifactId);
    expect(coverIds).toEqual([
      expect.stringMatching(/^artifact_/u),
      coverIds?.[0],
    ]);
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const exactOne = (table: string, predicate: string) =>
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`)
          .get() as { readonly count: number }
      ).count;
    expect(
      exactOne("artifact_associations", "role = 'asset.primary-cover'"),
    ).toBe(1);
    expect(
      exactOne(
        "artifacts",
        "id IN (SELECT artifact_id FROM artifact_associations WHERE role = 'asset.primary-cover')",
      ),
    ).toBe(1);
    expect(
      exactOne(
        "locations",
        "artifact_id IN (SELECT artifact_id FROM artifact_associations WHERE role = 'asset.primary-cover')",
      ),
    ).toBe(1);
    expect(
      exactOne(
        "artifact_revisions",
        "artifact_id IN (SELECT artifact_id FROM artifact_associations WHERE role = 'asset.primary-cover')",
      ),
    ).toBe(1);
    expect(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM recognition_decisions")
          .get() as { readonly count: number }
      ).count,
    ).toBe(2);
    database.close();
    await expect(
      laterWorkflow.resume({
        executionId: "multi-interrupted",
        acceptTrusted: true,
      }),
    ).rejects.toThrow("只有未完成的刷新记录可以继续");

    state.releaseSecondStore?.();
    await expect(interrupted).rejects.toThrow();
    laterCatalogue.close();
  });

  it("fails a recovered conflicting pending sibling before acquiring or storing source artifacts", async () => {
    const { root, catalogue: firstCatalogue } = await createCatalogueWithRoot();
    const state = {
      generation: randomUUID(),
      blockSecondStore: false,
      conflictingSecondCandidate: true,
      counts: {
        directory: 0,
        collect: 0,
        interpret: 0,
        recognize: 0,
        acquire: 0,
        storeSecond: 0,
      },
    };
    const requirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [{ property: "asset.title", necessity: "required" as const }],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "required" as const,
          maximum: 1,
        },
      ],
      relationshipTypes: [],
    };
    const interrupted = scanFixtureRegisteredObservedScope(
      multiRecoveryWorkflow(firstCatalogue, state),
      {
        directory: "/observed/conflicting-recovery",
        executionId: "conflicting-recovery",
        acceptTrusted: true,
        informationRequirement: requirement,
        onCheckpoint: (execution) => {
          const first = execution.workItems?.find((item) => item.key === "one");
          const second = execution.workItems?.find(
            (item) => item.key === "two",
          );
          if (first?.outcome === "accepted" && second?.outcome === undefined)
            throw new Error("planned checkpoint interruption");
        },
      },
    );
    await expect(interrupted).rejects.toThrow(
      "planned checkpoint interruption",
    );
    const checkpoint = await firstCatalogue.inspectExecution(
      "conflicting-recovery",
    );
    expect(checkpoint?.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "one", outcome: "accepted" }),
        expect.objectContaining({ key: "two" }),
      ]),
    );
    expect(
      checkpoint?.execution.workItems?.find((item) => item.key === "two")
        ?.outcome,
    ).toBeUndefined();
    const countsAtInterruption = { ...state.counts };
    firstCatalogue.close();

    const laterCatalogue = SqliteCatalogue.forProductData(root);
    const resumed = await multiRecoveryWorkflow(laterCatalogue, state).resume({
      executionId: "conflicting-recovery",
      acceptTrusted: true,
    });

    expect(resumed.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "one", outcome: "accepted" }),
        expect.objectContaining({
          key: "two",
          outcome: "failed",
          reason:
            "Source Artifact Candidate has contradictory acquisition semantics",
        }),
      ]),
    );
    expect(state.counts.acquire).toBe(countsAtInterruption.acquire);
    expect(state.counts.storeSecond).toBe(countsAtInterruption.storeSecond);

    laterCatalogue.close();
  });

  it("reopens a multi-product source decision whose query address differs from both products", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const state = {
      generation: randomUUID(),
      blockSecondStore: false,
      counts: {
        directory: 0,
        collect: 0,
        interpret: 0,
        recognize: 0,
        acquire: 0,
        storeSecond: 0,
      },
    };
    const initialWorkflow = recoveryWorkflow(catalogue, {
      includeFormatFacts: true,
    });
    await scanFixtureRegisteredObservedScope(initialWorkflow, {
      directory: "/observed/multi",
      acceptTrusted: true,
      executionId: "multi-source-decision",
    });
    const accepted = await catalogue.inspectExecution("multi-source-decision");
    const assetId = accepted?.workItemInspections?.[0]?.accepted?.entity.id;
    if (assetId === undefined)
      throw new Error("multi fixture did not accept a source-decision target");
    state.generation = randomUUID();
    const workflow = multiRecoveryWorkflow(catalogue, state);

    const prepared = await workflow.prepareConflictedEstablishment({
      assetId,
      sourceIdentity: "multi",
      sourceInput: { address: "opaque:query" },
      initiatedBy: "reviewer",
    });
    expect(prepared.state).toBe("awaiting-selection");
    expect(prepared.candidates).toHaveLength(2);
    catalogue.close();

    const reopened = SqliteCatalogue.forProductData(root);
    const recovered = multiRecoveryWorkflow(reopened, state);
    const awaiting = await recovered.inspectSourceAssociationDecision(
      prepared.executionId,
    );
    expect(awaiting).toMatchObject({ state: "awaiting-selection" });
    expect(awaiting?.candidates).toHaveLength(2);

    const selected = await recovered.selectSourceAssociationCandidate({
      executionId: prepared.executionId,
      candidateReference: awaiting!.candidates[1].reference,
    });
    expect(selected.state).toBe("awaiting-confirmation");
    expect(selected.preview?.projected.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          sourceSlot: "multi.title",
          value: "two",
        }),
      ]),
    );
    expect(selected.preview?.projected.metadata).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceSlot: "multi.title", value: "one" }),
      ]),
    );
    expect(selected.preview?.projected.sourceAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIdentity: "multi",
          nativeAddress: "opaque:two",
        }),
      ]),
    );
    const durablePreview = await reopened.inspectChangeImpactPreview(
      selected.preview!.id,
    );
    expect(durablePreview?.projected.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceSlot: "multi.title",
          sourceRecordIds: [expect.stringContaining("product-record-two-")],
        }),
      ]),
    );
    expect(durablePreview?.projected.metadata).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceSlot: "multi.title",
          sourceRecordIds: [expect.stringContaining("product-record-one-")],
        }),
      ]),
    );
    reopened.close();
  });

  it("rebuilds a legal recognizer proposal from actual interpreter and format producers after SQLite restart", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const executionId = "recognizer-provenance-restart";

    const applied = await recoveryWorkflow(catalogue, {
      includeFormatFacts: true,
    }).scanObservedScope({
      registrationId: "/observed",
      relativeScope: ".",
      acceptTrusted: true,
      executionId,
    });

    expect(applied.execution.outcome, JSON.stringify(applied.execution)).toBe(
      "accepted",
    );
    catalogue.close();

    const reopened = SqliteCatalogue.forProductData(root);
    const inspection = await reopened.inspectExecution(executionId);
    const interpreter = {
      capabilityId: "recovery.interpreter",
      capabilityVersion: "1",
      contractVersion: "1",
    };
    const formatInspector = {
      capabilityId: "recovery.format-inspector",
      capabilityVersion: "1",
      contractVersion: "1",
    };
    const accepted = inspection?.workItemInspections?.[0]?.accepted;

    expect(accepted?.proposal.basis.interpretation.producer).toEqual(
      interpreter,
    );
    expect(accepted?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceSlot: "recovery.title",
          producer: interpreter,
        }),
        expect.objectContaining({
          sourceSlot: "recovery.format.title",
          producer: formatInspector,
        }),
      ]),
    );
    expect(accepted?.artifactRevisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blobDigest: "recovery-format-parent-digest",
          producer: formatInspector,
        }),
      ]),
    );
    expect(accepted?.observedEntityGraphs).toEqual([
      expect.objectContaining({
        artifactId: expect.any(String),
        revisionId: expect.any(String),
        complete: true,
        entities: [
          expect.objectContaining({
            label: "Recovery local contributor",
            occurrenceSlot: "recovery.format.contributor",
          }),
        ],
      }),
    ]);
    if (accepted === undefined)
      throw new Error("missing accepted recognition after SQLite reopen");
    const retractionWorkflow = recoveryWorkflow(reopened, {
      includeFormatFacts: true,
    });
    const retraction = await retractionWorkflow.prepareRecognitionRetraction({
      assetId: accepted.entity.id,
      predecessorDecisionId: accepted.recognitionDecision.id,
      proposedBy: "reviewer",
      reason: "test current observed graph removal",
    });
    await retractionWorkflow.applyChangeImpactPreview({
      previewId: retraction.id,
      confirmedBy: "reviewer",
    });
    await expect(
      reopened.findAcceptedForSubjects([accepted.entity.id]),
    ).resolves.toEqual([]);
    reopened.close();
  });

  it("adds only the no-change execution when an ordinary scan reuses an unchanged accepted graph", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const workflow = recoveryWorkflow(catalogue);
    const first = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed",
      acceptTrusted: true,
      executionId: "first-ordinary-scan",
    });
    expect(first.execution.outcome).toBe("accepted");

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const persistentGraph = () => {
      const ids = (sql: string) =>
        (
          database.prepare(sql).all() as unknown as readonly {
            readonly id: string | number;
          }[]
        ).map((row) => String(row.id));
      return {
        digitalAssets: ids(
          "SELECT entity_id AS id FROM entity_kind_assertions WHERE kind = 'digital-asset' ORDER BY entity_id",
        ),
        entities: ids("SELECT id FROM entities ORDER BY id"),
        mentions: ids("SELECT id FROM entity_mentions ORDER BY id"),
        resolutionDecisions: ids(
          "SELECT id FROM entity_resolution_decisions ORDER BY id",
        ),
        relationships: ids("SELECT id FROM entity_relationships ORDER BY id"),
        artifacts: ids("SELECT id FROM artifacts ORDER BY id"),
        locations: ids("SELECT id FROM locations ORDER BY id"),
        blobs: (
          database
            .prepare("SELECT digest AS id FROM blobs ORDER BY digest")
            .all() as unknown as readonly { readonly id: string }[]
        ).map((row) => row.id),
        revisions: ids("SELECT id FROM artifact_revisions ORDER BY id"),
        associations: ids("SELECT id FROM artifact_associations ORDER BY id"),
        sourceRecords: ids("SELECT id FROM source_records ORDER BY id"),
        assertions: ids("SELECT id FROM metadata_assertions ORDER BY id"),
        proposals: ids("SELECT id FROM recognition_proposals ORDER BY id"),
        recognitionDecisions: ids(
          "SELECT id FROM recognition_decisions ORDER BY id",
        ),
      };
    };
    const before = persistentGraph();
    const executionsBefore = (
      database
        .prepare("SELECT id FROM workflow_executions ORDER BY id")
        .all() as unknown as readonly { readonly id: string }[]
    ).map((row) => row.id);

    const second = await scanFixtureRegisteredObservedScope(workflow, {
      directory: "/observed",
      acceptTrusted: true,
      executionId: "second-ordinary-scan",
    });

    expect(second.execution).toMatchObject({
      id: "second-ordinary-scan",
      outcome: "no-change",
      reusedExecutionId: "first-ordinary-scan",
    });
    expect(second.sourceRecords).toEqual([]);
    expect(persistentGraph()).toEqual(before);
    const executionsAfter = database
      .prepare(
        `SELECT id, outcome, reused_execution_id
         FROM workflow_executions ORDER BY id`,
      )
      .all() as unknown as readonly {
      readonly id: string;
      readonly outcome: string | null;
      readonly reused_execution_id: string | null;
    }[];
    expect(executionsAfter.map((row) => row.id)).toEqual([
      ...executionsBefore,
      "second-ordinary-scan",
    ]);
    expect(executionsAfter.at(-1)).toEqual({
      id: "second-ordinary-scan",
      outcome: "no-change",
      reused_execution_id: "first-ordinary-scan",
    });
    database.close();
  });

  it("cannot retain or expose raw, JSON-escaped, or percent-encoded private FANBOX configuration through SQLite restart", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const secret = "full-chain+private/token";
    const reflections = [
      secret,
      Array.from(secret)
        .map(
          (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
        )
        .join(""),
      encodeURIComponent(secret),
    ];
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      {
        id: "snapshot",
        root: "/observed/25.01.01 post",
        complete: true,
        files: [],
        excluded: [],
        observedAt: "2026-07-29T00:00:00.000Z",
      },
    )[0];

    for (const [index, reflection] of reflections.entries()) {
      const title =
        index === 1 ? `"${reflection}"` : JSON.stringify(reflection);
      const assembly = createScriptedFanboxProductAssembly(async () => ({
        kind: "response",
        status: 200,
        mediaType: "application/json",
        body: new TextEncoder().encode(
          `{"body":{"items":[{"id":"9135862","creatorId":"customudon","title":${title},"publishedDatetime":"2025-01-01T00:11:17+09:00"}]}}`,
        ),
      }));
      const collector = assembly.createCollector({
        creatorIds: () => ["customudon"],
        privateConfigurationForExecution: () =>
          JSON.stringify({
            format: "fanbox-browser-request-context/2",
            userAgent: "composition-test/1",
            cookies: [
              {
                name: "FANBOXSESSID",
                value: secret,
                domain: ".fanbox.cc",
                path: "/",
              },
            ],
          }),
      });
      const collected = await collector.collect(evidence);
      await assembly.close();
      const initial = { ...execution(), id: `fanbox-secret-${index}` };

      expect(collected.records).toEqual([]);
      expect(JSON.stringify(collected)).not.toContain(secret);
      expect(JSON.stringify(collected)).not.toContain(reflection);
      await catalogue.createExecution(initial);
      await retainSourceRecords(catalogue, initial.id, collected.records);
      await catalogue.finishExecution(initial, {
        ...initial,
        status: "failed",
        stage: "failed",
        outcome: "failed",
        reason: collected.failures[0]?.reason,
      });

      const publicInspection = await catalogue.inspectExecution(initial.id);
      const rawInspection = await catalogue.inspectRawSourceRecord(
        initial.id,
        "reflected-response",
      );
      expect(JSON.stringify(publicInspection)).not.toContain(secret);
      expect(JSON.stringify(publicInspection)).not.toContain(reflection);
      expect(rawInspection).toBeUndefined();
    }
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM source_records").get(),
    ).toEqual({ count: 0 });
    expect(
      JSON.stringify(
        database
          .prepare(
            "SELECT reason, source_record_ids_json FROM workflow_executions WHERE id LIKE 'fanbox-secret-%'",
          )
          .all(),
      ),
    ).not.toContain(secret);
    database.close();

    catalogue.close();
    const reopened = SqliteCatalogue.forProductData(root);
    for (const [index, reflection] of reflections.entries()) {
      const inspection = await reopened.inspectExecution(
        `fanbox-secret-${index}`,
      );
      expect(JSON.stringify(inspection)).not.toContain(secret);
      expect(JSON.stringify(inspection)).not.toContain(reflection);
    }
    reopened.close();
  });

  it("atomically creates an automation execution with its claim and reconciles terminal state", async () => {
    const catalogue = await createCatalogue();
    await catalogue.createAutomationIntentForTesting({
      id: "intent",
      scope: { observedRootId: "/observed", relativeScope: "." },
      enabled: true,
      intervalMilliseconds: 1_000,
      workflowInputVersion: "asset-refresh-input/1",
      runInitial: true,
      policyReferences: ["policy"],
      acceptTrusted: true,
    });
    const first = {
      ...execution(),
      id: "first",
      automationIntentId: "intent",
      trigger: "interval" as const,
    };
    await expect(
      catalogue.createExecution(first, "2026-07-29T00:00:00.000Z"),
    ).resolves.toBe("started");
    await expect(catalogue.inspectExecution("first")).resolves.toMatchObject({
      execution: {
        id: "first",
        status: "running",
        automationIntentId: "intent",
      },
    });
    const overlapping = {
      ...first,
      id: "overlapping",
    };
    await expect(
      catalogue.createExecution(overlapping, "2026-07-29T00:00:01.000Z"),
    ).resolves.toBe("skipped");
    await expect(catalogue.inspectExecution("overlapping")).resolves.toBe(
      undefined,
    );
    await catalogue.finishExecution(first, {
      ...first,
      status: "completed",
      stage: "completed",
      outcome: "unresolved",
    });
    const afterTerminal = {
      ...first,
      id: "after-terminal",
    };
    await expect(
      catalogue.createExecution(afterTerminal, "2026-07-29T00:00:02.000Z"),
    ).resolves.toBe("started");
  });

  it("reconciles a legacy claim that has no Workflow Execution", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const catalogue = SqliteCatalogue.forProductData(root);
    await catalogue.createAutomationIntentForTesting({
      id: "intent",
      scope: { observedRootId: "/observed", relativeScope: "." },
      enabled: true,
      intervalMilliseconds: 1_000,
      workflowInputVersion: "asset-refresh-input/1",
      runInitial: true,
      policyReferences: ["policy"],
      acceptTrusted: true,
    });
    const legacy = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    legacy
      .prepare(
        "UPDATE automation_runtime SET active_execution_id = ? WHERE intent_id = ?",
      )
      .run("legacy-claim-before-create", "intent");
    legacy.close();

    await expect(
      catalogue.createExecution(
        {
          ...execution(),
          id: "reconciled",
          automationIntentId: "intent",
          trigger: "interval",
        },
        "2026-07-29T00:00:00.000Z",
      ),
    ).resolves.toBe("started");
    await expect(
      catalogue.inspectExecution("reconciled"),
    ).resolves.toBeDefined();
  });

  it("runs initial, due interval, scan-now, fixed-snapshot and disable behavior through a real SQLite automation host", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const catalogue = SqliteCatalogue.forProductData(root);
    let fileCount = 1;
    const observedRootRegistrations = inMemoryObservedRootRegistrations({
      capability: {
        capabilityId: "automation.observer",
        capabilityVersion: "1",
        contractVersion: "1",
      },
      async observe({ scope }) {
        const directory = scope.logicalLocation;
        return {
          id: `snapshot-${fileCount}`,
          root: directory,
          complete: true,
          observedAt: `2026-07-29T00:00:0${fileCount}.000Z`,
          excluded: [],
          files: Array.from({ length: fileCount }, (_, index) => ({
            relativePath: `file-${index}.bin`,
            size: index + 1,
            modifiedAt: "2026-07-29T00:00:00.000Z",
          })),
        };
      },
    });
    const baseWorkflow = new AssetRefreshWorkflow({
      observedRootRegistrations,
      directoryInterpreters: [],
      collectors: [],
      sourceInterpreters: [],
      recognizers: [],
      recognitionPolicy: { version: "policy/1", accepts: () => false },
      acquirers: [],
      managedStore: {
        async store() {
          throw new Error("unresolved automation does not store artifacts");
        },
      },
      executionCommands: catalogue,
      executionQueries: catalogue,
      recoveryLease: catalogue,
      reuseQueries: catalogue,
      recognitionAcceptance: catalogue,
      recognitionReevaluation: catalogue,
      recognitionChangeImpact: catalogue,
      metadataRefreshPersistence: catalogue,
      changeImpactQueries: catalogue,
      changeImpactCommands: catalogue,
    });
    const workflow = attachAssetRefreshAutomation(
      baseWorkflow,
      new AssetRefreshAutomation(baseWorkflow, {
        executionQueries: catalogue,
        automationQueries: catalogue,
        automationCommands: {
          async createAutomationIntentForObservedRoot({ intent }) {
            await catalogue.createAutomationIntentForTesting(intent);
            return { status: "created" as const };
          },
          releaseAutomationTrigger:
            catalogue.releaseAutomationTrigger.bind(catalogue),
          setAutomationIntentEnabled:
            catalogue.setAutomationIntentEnabled.bind(catalogue),
        },
        observedRootRegistrations,
        recognitionPolicyVersion: "policy/1",
      }),
    );
    const enabled = await workflow.enableAutomation({
      observedRootId: "/bounded",
      relativeScope: ".",
      intervalMilliseconds: 1_000,
      acceptTrusted: false,
      runInitial: false,
    });
    let now = new Date("2026-07-29T00:00:00.000Z");
    let timer: (() => void) | undefined;
    const host = new AutomationHost(workflow, {
      pollIntervalMilliseconds: 100,
      clock: {
        now: () => now,
        setInterval(callback) {
          timer = callback;
          return "host-timer";
        },
        clearInterval() {},
      },
    });
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const executionRows = () =>
      database
        .prepare(
          `SELECT snapshot_json, workflow_input_json FROM workflow_executions
           WHERE automation_intent_id = ? ORDER BY rowid`,
        )
        .all(enabled.intent.id) as Array<{
        readonly snapshot_json: string;
        readonly workflow_input_json: string;
      }>;

    await host.start();
    expect(executionRows()).toHaveLength(1);
    now = new Date("2026-07-29T00:00:00.999Z");
    fileCount = 2;
    timer?.();
    await host.settled();
    expect(executionRows()).toHaveLength(1);
    now = new Date("2026-07-29T00:00:01.000Z");
    timer?.();
    await host.settled();
    expect(executionRows()).toHaveLength(2);
    expect(JSON.parse(executionRows()[0].snapshot_json).files).toHaveLength(1);
    expect(JSON.parse(executionRows()[1].snapshot_json).files).toHaveLength(2);

    fileCount = 3;
    await expect(
      workflow.triggerAutomation(enabled.intent.id, "scan-now", now),
    ).resolves.toMatchObject({ status: "started" });
    expect(executionRows()).toHaveLength(3);
    expect(JSON.parse(executionRows()[2].workflow_input_json)).toMatchObject({
      trigger: "scan-now",
    });
    await workflow.disableAutomation(enabled.intent.id);
    now = new Date("2026-07-29T00:00:02.000Z");
    timer?.();
    await host.settled();
    expect(executionRows()).toHaveLength(3);
    host.stop();
    database.close();

    const initial = await workflow.enableAutomation({
      observedRootId: "/another-bounded-scope",
      relativeScope: ".",
      intervalMilliseconds: 1_000,
      acceptTrusted: false,
    });
    expect(initial.initial).toMatchObject({
      status: "started",
      execution: {
        execution: {
          workflowInput: { trigger: "initial" },
          snapshot: { files: expect.any(Array) },
        },
      },
    });
  });

  it("stops a due interval at its next SQLite checkpoint before starting a sibling intent", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const catalogue = SqliteCatalogue.forProductData(root);
    let releaseCollection!: () => void;
    const collectionBarrier = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    let collectionStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      collectionStarted = resolve;
    });
    const collectionCalls = { count: 0 };
    const observedDirectories: string[] = [];
    const workflow = recoveryWorkflow(catalogue, {
      collectionBarrier,
      onCollectionStarted: collectionStarted,
      collectionCalls,
      observedDirectories,
    });
    const first = await workflow.enableAutomation({
      observedRootId: "/shutdown-first",
      relativeScope: ".",
      intervalMilliseconds: 60_000,
      acceptTrusted: true,
      runInitial: false,
    });
    await workflow.enableAutomation({
      observedRootId: "/shutdown-sibling",
      relativeScope: ".",
      intervalMilliseconds: 60_000,
      acceptTrusted: true,
      runInitial: false,
    });
    const executionHost = new ExecutionHost();
    const automationHost = new AutomationHost(workflow, { executionHost });

    const starting = automationHost.start();
    await entered;
    automationHost.stop();
    const closing = executionHost.close();
    let automaticFactoryCalls = 0;
    await expect(
      executionHost.runWithControl(async () => {
        automaticFactoryCalls += 1;
      }),
    ).rejects.toThrow("执行服务正在关闭，请稍后重试");
    releaseCollection();

    await expect(closing).resolves.toBeUndefined();
    await expect(starting).resolves.toBeUndefined();
    await expect(automationHost.settled()).resolves.toBeUndefined();
    expect(automaticFactoryCalls).toBe(0);
    expect(collectionCalls.count).toBe(1);
    expect(observedDirectories).toEqual(["/shutdown-first"]);
    const running = await catalogue.listRunningExecutions();
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      automationIntentId: first.intent.id,
      status: "running",
      stage: "source-records-retained",
    });
    expect(running[0]).not.toHaveProperty("cancellationRequestedAt");
    const replacementHost = new ExecutionHost();
    const resumed = await replacementHost.runWithControl(
      async () => await workflow.resume({ executionId: running[0].id }),
    );
    expect(resumed.execution).toMatchObject({
      status: "completed",
      outcome: "accepted",
    });
    await replacementHost.close();
    catalogue.close();
  });

  it("composes manual and Host checkpoint callbacks once in caller-then-Host order", async () => {
    const catalogue = await createCatalogue();
    const workflow = recoveryWorkflow(catalogue);
    const events: string[] = [];
    await expect(
      workflow.scanObservedScope({
        registrationId: "/composed-checkpoints",
        relativeScope: ".",
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [],
          artifactRoles: [
            {
              role: "asset.primary-cover",
              necessity: "required",
              maximum: 1,
            },
          ],
          relationshipTypes: [],
        },
        onCheckpoint(execution) {
          events.push(`caller:${execution.stage}`);
        },
        onHostCheckpoint(execution) {
          events.push(`host:${execution.stage}`);
        },
      }),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
    });
    expect(events).toEqual([
      "host:recognition",
      "caller:source-records-retained",
      "host:source-records-retained",
      "caller:source-artifacts-acquired",
      "host:source-artifacts-acquired",
      "caller:source-artifacts-stored",
      "host:source-artifacts-stored",
    ]);
    catalogue.close();
  });

  it("keeps an active execution through disable and safely reconciles it after a process restart", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const first = SqliteCatalogue.forProductData(root);
    await first.createAutomationIntentForTesting({
      id: "intent",
      scope: { observedRootId: "/bounded", relativeScope: "." },
      enabled: true,
      intervalMilliseconds: 1_000,
      workflowInputVersion: "asset-refresh-input/1",
      runInitial: true,
      policyReferences: ["policy"],
      acceptTrusted: false,
    });
    const crashed = {
      ...execution(),
      id: "crashed",
      automationIntentId: "intent",
      trigger: "interval" as const,
    };
    await expect(
      first.createExecution(crashed, "2026-07-29T00:00:00.000Z"),
    ).resolves.toBe("started");
    await first.setAutomationIntentEnabled("intent", false);
    await expect(first.inspectExecution("crashed")).resolves.toMatchObject({
      execution: { status: "running" },
    });

    const later = SqliteCatalogue.forProductData(root);
    await expect(
      later.createExecution(
        { ...crashed, id: "disabled-attempt" },
        "2026-07-29T00:00:01.000Z",
      ),
    ).resolves.toBe("disabled");
    await later.setAutomationIntentEnabled("intent", true);
    await expect(
      later.createExecution(
        { ...crashed, id: "overlap-after-restart" },
        "2026-07-29T00:00:01.000Z",
      ),
    ).resolves.toBe("skipped");
    await later.finishExecution(crashed, {
      ...crashed,
      status: "failed",
      stage: "failed",
      outcome: "failed",
      reason: "process interrupted before a resumable checkpoint",
    });

    const restarted = SqliteCatalogue.forProductData(root);
    await expect(
      restarted.createExecution(
        { ...crashed, id: "after-terminal-reconcile" },
        "2026-07-29T00:00:02.000Z",
      ),
    ).resolves.toBe("started");
  });

  it("resumes a durable running automation execution through a new host instance before allowing another trigger", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const firstCatalogue = SqliteCatalogue.forProductData(root);
    const firstWorkflow = recoveryWorkflow(firstCatalogue);
    const enabled = await firstWorkflow.enableAutomation({
      observedRootId: "/bounded-recovery",
      relativeScope: ".",
      intervalMilliseconds: 60_000,
      acceptTrusted: true,
      runInitial: false,
    });
    const executionHost = new ExecutionHost();
    let closing!: Promise<void>;
    await expect(
      executionHost.invoke(async (control) => {
        await scanFixtureRegisteredObservedScope(firstWorkflow, {
          directory: "/bounded-recovery",
          acceptTrusted: true,
          executionId: "hard-crash-execution",
          automationIntentId: enabled.intent.id,
          trigger: "interval",
          requestedAt: "2026-07-29T00:00:00.000Z",
          onExecutionStarted(execution) {
            control.executionStarted(execution.id);
            closing = executionHost.close();
          },
          onCheckpoint() {
            control.safeCheckpoint();
          },
        });
      }),
    ).resolves.toEqual({ id: "hard-crash-execution" });
    await expect(closing).resolves.toBeUndefined();
    const stopped = await firstWorkflow.inspect("hard-crash-execution");
    expect(stopped).toMatchObject({
      execution: {
        status: "running",
      },
    });
    expect(stopped.execution).not.toHaveProperty("cancellationRequestedAt");
    await firstWorkflow.disableAutomation(enabled.intent.id);

    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    const restartedWorkflow = recoveryWorkflow(restartedCatalogue);
    const host = new AutomationHost(restartedWorkflow);
    await host.start();
    host.stop();
    await expect(
      restartedWorkflow.inspect("hard-crash-execution"),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
    });

    await restartedCatalogue.setAutomationIntentEnabled(
      enabled.intent.id,
      true,
    );
    await expect(
      restartedWorkflow.triggerAutomation(enabled.intent.id, "scan-now"),
    ).resolves.toMatchObject({ status: "started" });
  });

  it("keeps a durable SQLite recovery claim waiting until its owner releases it, then resumes without a duplicate", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const firstCatalogue = SqliteCatalogue.forProductData(root);
    const firstWorkflow = recoveryWorkflow(firstCatalogue);
    let executionId = "";
    await expect(
      scanFixtureRegisteredObservedScope(firstWorkflow, {
        directory: "/bounded-recovery",
        executionId: "recovery-claim-barrier",
        acceptTrusted: true,
        onCheckpoint(execution) {
          executionId = execution.id;
          throw new Error("simulated crash before recovery");
        },
      }),
    ).rejects.toThrow("simulated crash before recovery");
    await expect(
      firstCatalogue.claimResumeExecution({
        executionId,
        token: "crashed-owner",
        now: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).resolves.toBe("claimed");
    firstCatalogue.close();

    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    let timer: (() => void) | undefined;
    const host = new AutomationHost(recoveryWorkflow(restartedCatalogue), {
      clock: {
        now: () => new Date(),
        setInterval(callback) {
          timer = callback;
          return "recovery-timer";
        },
        clearInterval() {},
      },
    });
    await expect(host.start()).resolves.toBeUndefined();
    // 等待是已完成的恢复分类，而不是全局准入失败。宿主继续监督保留执行，不创建副本。
    expect(host.recoveryReady).toBe(true);
    await expect(
      restartedCatalogue.inspectExecution(executionId),
    ).resolves.toMatchObject({ execution: { status: "running" } });
    await expect(
      restartedCatalogue.releaseResumeExecutionClaim({
        executionId,
        token: "crashed-owner",
      }),
    ).resolves.toBeUndefined();
    timer?.();
    await host.settled();
    expect(host.recoveryReady).toBe(true);
    await expect(
      restartedCatalogue.inspectExecution(executionId),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
    });
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM workflow_executions")
        .get(),
    ).toEqual({ count: 1 });
    database.close();
    host.stop();
    restartedCatalogue.close();
  });

  it("releases a startup-recovery claim on graceful Host shutdown so its replacement can resume immediately", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const firstCatalogue = SqliteCatalogue.forProductData(root);
    const firstWorkflow = recoveryWorkflow(firstCatalogue);
    await expect(
      scanFixtureRegisteredObservedScope(firstWorkflow, {
        directory: "/recovery-owner-handoff",
        executionId: "recovery-owner-handoff",
        acceptTrusted: true,
        onCheckpoint() {
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow("simulated process interruption");
    await expect(
      firstWorkflow.inspect("recovery-owner-handoff"),
    ).resolves.toMatchObject({ execution: { status: "running" } });
    firstCatalogue.close();

    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    const restartedWorkflow = recoveryWorkflow(restartedCatalogue);
    const stoppingHost = new ExecutionHost();
    let closing!: Promise<void>;
    await expect(
      stoppingHost.runWithControl(async (control) => {
        await restartedWorkflow.recoverRunningExecutions({
          onCheckpoint() {
            closing = stoppingHost.close();
            control.safeCheckpoint();
          },
        });
      }),
    ).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    await expect(
      restartedWorkflow.inspect("recovery-owner-handoff"),
    ).resolves.toMatchObject({ execution: { status: "running" } });

    const replacementHost = new ExecutionHost();
    await expect(
      replacementHost.runWithControl(async () => {
        await restartedWorkflow.resume({
          executionId: "recovery-owner-handoff",
        });
      }),
    ).resolves.toBeUndefined();
    await expect(
      restartedWorkflow.inspect("recovery-owner-handoff"),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
    });
    await replacementHost.close();
    restartedCatalogue.close();
  });

  it("stops retained startup recovery at its next durable checkpoint without claiming a sibling", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const firstCatalogue = SqliteCatalogue.forProductData(root);
    const firstWorkflow = recoveryWorkflow(firstCatalogue, {
      uniqueRecordIds: true,
      uniqueProposalIds: true,
    });
    for (const executionId of ["retained-first", "retained-sibling"]) {
      await expect(
        scanFixtureRegisteredObservedScope(firstWorkflow, {
          directory: `/${executionId}`,
          executionId,
          acceptTrusted: true,
          informationRequirement: {
            metadataUsageContext: "asset.ordinary",
            metadata: [],
            artifactRoles: [
              {
                role: "asset.primary-cover",
                necessity: "required",
                maximum: 1,
              },
            ],
            relationshipTypes: [],
          },
          onCheckpoint() {
            throw new Error("simulated retained process interruption");
          },
        }),
      ).rejects.toThrow("simulated retained process interruption");
    }
    firstCatalogue.close();

    let releaseAcquisition!: () => void;
    const acquisitionBarrier = new Promise<void>((resolve) => {
      releaseAcquisition = resolve;
    });
    let acquisitionStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      acquisitionStarted = resolve;
    });
    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    const restartedWorkflow = recoveryWorkflow(restartedCatalogue, {
      uniqueRecordIds: true,
      uniqueProposalIds: true,
      acquisitionBarrier,
      onAcquisitionStarted: acquisitionStarted,
    });
    const executionHost = new ExecutionHost();
    let closing!: Promise<void>;
    const recovering = executionHost.runWithControl(
      async (control) =>
        await restartedWorkflow.recoverRunningExecutions({
          onCheckpoint: control.safeCheckpoint,
        }),
    );
    await expect(
      Promise.race([
        entered.then(() => "acquisition-started"),
        recovering.then(() => "recovery-completed"),
      ]),
    ).resolves.toBe("acquisition-started");
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    const claims = () =>
      database
        .prepare(
          "SELECT id, resume_claim_token FROM workflow_executions WHERE id IN (?, ?) ORDER BY id",
        )
        .all("retained-first", "retained-sibling") as {
        readonly id: string;
        readonly resume_claim_token: string | null;
      }[];
    expect(claims()).toEqual([
      { id: "retained-first", resume_claim_token: expect.any(String) },
      { id: "retained-sibling", resume_claim_token: null },
    ]);

    closing = executionHost.close();
    releaseAcquisition();
    await expect(recovering).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(claims()).toEqual([
      { id: "retained-first", resume_claim_token: null },
      { id: "retained-sibling", resume_claim_token: null },
    ]);
    await expect(
      restartedWorkflow.inspect("retained-first"),
    ).resolves.toMatchObject({
      execution: { status: "running", stage: "source-artifacts-acquired" },
    });
    await expect(
      restartedWorkflow.inspect("retained-sibling"),
    ).resolves.toMatchObject({
      execution: { status: "running", stage: "source-records-retained" },
    });

    const replacementHost = new ExecutionHost();
    await expect(
      replacementHost.runWithControl(
        async () => await restartedWorkflow.recoverRunningExecutions(),
      ),
    ).resolves.toHaveLength(2);
    await expect(
      restartedWorkflow.inspect("retained-first"),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
    });
    await expect(
      restartedWorkflow.inspect("retained-sibling"),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
    });
    await replacementHost.close();
    database.close();
    restartedCatalogue.close();
  });

  it("records an incompatible restart as interrupted without replaying frozen effects", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const calls = { count: 0 };
    const firstCatalogue = SqliteCatalogue.forProductData(root);
    const firstWorkflow = recoveryWorkflow(firstCatalogue, {
      collectorCapabilityVersion: "1",
      collectionCalls: calls,
    });

    await expect(
      scanFixtureRegisteredObservedScope(firstWorkflow, {
        directory: "/incompatible-recovery",
        executionId: "incompatible-recovery",
        acceptTrusted: true,
        onCheckpoint() {
          throw new Error("simulated hard crash");
        },
      }),
    ).rejects.toThrow("simulated hard crash");
    expect(calls.count).toBe(1);
    const before = await firstCatalogue.inspectExecution(
      "incompatible-recovery",
    );
    expect(before?.execution).toMatchObject({
      status: "running",
      compatibility: {
        capabilityCoordinates: expect.arrayContaining([
          "recovery.collector@1/1",
        ]),
      },
    });
    firstCatalogue.close();

    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    const restartedWorkflow = recoveryWorkflow(restartedCatalogue, {
      collectorCapabilityVersion: "2",
      collectionCalls: calls,
    });
    await expect(
      restartedWorkflow.resume({
        executionId: "incompatible-recovery",
        acceptTrusted: true,
      }),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        stage: "failed",
        outcome: "interrupted",
        reason: expect.stringContaining("实际参与能力的实现或契约不兼容"),
      },
    });
    expect(calls.count).toBe(1);
    await expect(
      restartedCatalogue.inspectExecution("incompatible-recovery"),
    ).resolves.toMatchObject({
      sourceRecords: before?.sourceRecords,
      execution: {
        compatibility: {
          capabilityCoordinates: expect.arrayContaining([
            "recovery.collector@1/1",
          ]),
        },
      },
    });
    restartedCatalogue.close();
  });

  for (const phase of ["acquiring", "applying", "reviewing"] as const) {
    it(`rejects replayed caller time before recovery cancels an expired ${phase} Run`, async () => {
      let authoritativeNow = new Date("1999-01-01T00:00:00.000Z");
      const root = await preparedCatalogueRoot();
      cleanup.push(root);
      const catalogue = SqliteCatalogue.forProductData(root, {
        clock: { now: () => authoritativeNow },
      });
      const { executionId, runId } =
        await createInterruptedRecoverySourceRefreshRun(catalogue, phase);
      await expect(
        catalogue.claimResumeExecution({
          executionId,
          token: `expired-owner:${phase}`,
          now: "1999-01-01T00:00:00.000Z",
          expiresAt: "2000-01-01T00:00:00.000Z",
        }),
      ).resolves.toBe("claimed");
      const beforeExecution = await catalogue.inspectExecution(executionId);
      const beforeRun = await catalogue.inspectSourceRefreshRun(runId);
      authoritativeNow = new Date("2026-08-02T00:00:00.000Z");

      await expect(
        catalogue.cancelUncommittedRun({
          executionId,
          runId,
          resumeClaim: {
            token: `expired-owner:${phase}`,
            now: "1999-01-01T00:00:00.000Z",
          },
        }),
      ).rejects.toThrow("stale resume claim");
      await expect(catalogue.inspectExecution(executionId)).resolves.toEqual(
        beforeExecution,
      );
      await expect(catalogue.inspectSourceRefreshRun(runId)).resolves.toEqual(
        beforeRun,
      );
      catalogue.close();
    });
  }

  for (const phase of ["acquiring", "applying", "reviewing"] as const) {
    it(`does not let a replaced recovery owner close a ${phase} Source Refresh Run`, async () => {
      let authoritativeNow = new Date("2098-12-31T23:59:00.000Z");
      const clock = { now: () => authoritativeNow };
      const resumeClock: AutomationClock = {
        now: () => authoritativeNow,
        setInterval: () => undefined,
        clearInterval() {},
      };
      const { root, catalogue } = await createCatalogueWithRoot({ clock });
      const { executionId, runId } =
        await createInterruptedRecoverySourceRefreshRun(catalogue, phase);
      const before = await catalogue.inspectExecution(executionId);
      expect(before).toBeDefined();
      expect(before?.sourceRefreshRuns).toMatchObject([{ phase }]);

      const contender = SqliteCatalogue.forProductData(root, {
        clock,
      });
      let handedOff = false;
      const handOff = async (parentExecutionId: string) => {
        if (handedOff) return;
        handedOff = true;
        authoritativeNow = new Date("2099-01-01T00:00:00.000Z");
        await expect(
          contender.claimResumeExecution({
            executionId: parentExecutionId,
            token: `new-owner:${phase}`,
            now: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:01:00.000Z",
          }),
        ).resolves.toBe("claimed");
      };
      const authority = {
        // 这是旧公开取消路径。生产修复前，恢复会在没有所有者条件时调用它，
        // 使旧所有者能在 `handOff` 成功后更改领域运行。
        async cancelSourceRefreshRun(runId: string) {
          await handOff(executionId);
          return await catalogue.cancelSourceRefreshRun(runId);
        },
        async cancelUncommittedRun(input: {
          readonly executionId: string;
          readonly runId: string;
          readonly resumeClaim: {
            readonly token: string;
            readonly now: string;
          };
        }) {
          await handOff(input.executionId);
          return await catalogue.cancelUncommittedRun(input);
        },
        async inspectSourceRefreshRun(runId: string) {
          return await catalogue.inspectSourceRefreshRun(runId);
        },
      };
      const workflow = recoveryWorkflow(catalogue, {
        sourceRefreshRuns: authority,
        recoverySourceRefreshRuns: authority,
        resumeClock,
      });

      await expect(workflow.resume({ executionId })).rejects.toThrow(
        "stale resume claim",
      );
      expect(await catalogue.inspectExecution(executionId)).toEqual(before);
      await expect(
        catalogue.inspectSourceRefreshRun(runId),
      ).resolves.toMatchObject({ phase });
      contender.close();
      catalogue.close();
    });
  }

  it("interrupts recovery when a frozen opaque configuration reference is unavailable", async () => {
    const { root, catalogue: firstCatalogue } = await createCatalogueWithRoot();
    const calls = { count: 0 };
    const executionId = "unavailable-configuration-recovery";
    const frozenReference = "source-connection:catalogue@version-1";
    const firstWorkflow = recoveryWorkflow(firstCatalogue, {
      collectionCalls: calls,
    });
    await expect(
      scanFixtureRegisteredObservedScope(firstWorkflow, {
        directory: "/observed/unavailable-configuration",
        executionId,
        acceptTrusted: true,
        configurationReferences: [frozenReference],
        onCheckpoint() {
          throw new Error("simulated hard crash");
        },
      }),
    ).rejects.toThrow("simulated hard crash");
    const before = await firstCatalogue.inspectExecution(executionId);
    expect(before?.execution.workflowInput?.configurationReferences).toEqual([
      frozenReference,
      "recognition-policy/recovery-policy/1",
    ]);
    firstCatalogue.close();

    const checked: readonly string[][] = [];
    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    const restartedWorkflow = recoveryWorkflow(restartedCatalogue, {
      collectionCalls: calls,
      configurationCompatibility: {
        async checkCompatibility(input: {
          readonly references: readonly string[];
        }) {
          (checked as string[][]).push([...input.references]);
          return {
            compatible: false as const,
            reason: "冻结配置当前不可用",
          };
        },
      },
    });

    await expect(
      restartedWorkflow.resume({ executionId }),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        outcome: "interrupted",
        reason: "冻结配置当前不可用",
      },
    });
    expect(checked).toEqual([
      [frozenReference, "recognition-policy/recovery-policy/1"],
    ]);
    expect(calls.count).toBe(1);
    await expect(
      restartedCatalogue.inspectExecution(executionId),
    ).resolves.toMatchObject({
      sourceRecords: before?.sourceRecords,
      execution: { outcome: "interrupted" },
    });
    restartedCatalogue.close();
  });

  it("interrupts recovery when a frozen opaque configuration reference changes version", async () => {
    const { root, catalogue: firstCatalogue } = await createCatalogueWithRoot();
    const calls = { count: 0 };
    const executionId = "changed-configuration-recovery";
    const frozenReference = "source-connection:catalogue@version-1";
    await expect(
      scanFixtureRegisteredObservedScope(
        recoveryWorkflow(firstCatalogue, { collectionCalls: calls }),
        {
          directory: "/observed/changed-configuration",
          executionId,
          acceptTrusted: true,
          configurationReferences: [frozenReference],
          onCheckpoint() {
            throw new Error("simulated hard crash");
          },
        },
      ),
    ).rejects.toThrow("simulated hard crash");
    const before = await firstCatalogue.inspectExecution(executionId);
    firstCatalogue.close();

    const checked: string[][] = [];
    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    const restartedWorkflow = recoveryWorkflow(restartedCatalogue, {
      collectionCalls: calls,
      configurationCompatibility: {
        async checkCompatibility(input) {
          checked.push([...input.references]);
          return {
            compatible: false,
            reason: "冻结配置版本已变更",
          };
        },
      },
    });

    await expect(
      restartedWorkflow.resume({ executionId }),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        outcome: "interrupted",
        reason: "冻结配置版本已变更",
      },
    });
    expect(checked).toEqual([
      [frozenReference, "recognition-policy/recovery-policy/1"],
    ]);
    expect(calls.count).toBe(1);
    await expect(
      restartedCatalogue.inspectExecution(executionId),
    ).resolves.toMatchObject({
      sourceRecords: before?.sourceRecords,
      execution: { outcome: "interrupted" },
    });
    restartedCatalogue.close();
  });

  it("resumes when every frozen opaque configuration reference remains compatible", async () => {
    const { root, catalogue: firstCatalogue } = await createCatalogueWithRoot();
    const calls = { count: 0 };
    const executionId = "compatible-configuration-recovery";
    const frozenReference = "source-connection:catalogue@version-1";
    await expect(
      scanFixtureRegisteredObservedScope(
        recoveryWorkflow(firstCatalogue, { collectionCalls: calls }),
        {
          directory: "/observed/compatible-configuration",
          executionId,
          acceptTrusted: true,
          configurationReferences: [frozenReference],
          onCheckpoint() {
            throw new Error("simulated hard crash");
          },
        },
      ),
    ).rejects.toThrow("simulated hard crash");
    firstCatalogue.close();

    const checked: string[][] = [];
    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    const restartedWorkflow = recoveryWorkflow(restartedCatalogue, {
      collectionCalls: calls,
      configurationCompatibility: {
        async checkCompatibility(input) {
          checked.push([...input.references]);
          return { compatible: true };
        },
      },
    });

    await expect(
      restartedWorkflow.resume({ executionId }),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
    });
    expect(checked).toEqual([
      [frozenReference, "recognition-policy/recovery-policy/1"],
    ]);
    expect(calls.count).toBe(1);
    restartedCatalogue.close();
  });

  it("uses an automatic execution's frozen references after its Automation Intent changes", async () => {
    const { root, catalogue: firstCatalogue } = await createCatalogueWithRoot();
    const calls = { count: 0 };
    const executionId = "frozen-automation-configuration-recovery";
    const frozenReference = "source-connection:catalogue@version-1";
    const currentReference = "source-connection:catalogue@version-2";
    const firstWorkflow = recoveryWorkflow(firstCatalogue, {
      collectionCalls: calls,
    });
    const enabled = await firstWorkflow.enableAutomation({
      observedRootId: "/observed/frozen-automation-configuration",
      relativeScope: ".",
      intervalMilliseconds: 60_000,
      acceptTrusted: false,
      policyReferences: [frozenReference],
      runInitial: false,
    });

    await expect(
      scanFixtureRegisteredObservedScope(firstWorkflow, {
        directory: enabled.intent.scope.observedRootId,
        executionId,
        automationIntentId: enabled.intent.id,
        trigger: "interval",
        initiatedBy: `automation:${enabled.intent.id}`,
        acceptTrusted: enabled.intent.acceptTrusted,
        configurationReferences: enabled.intent.policyReferences,
        onCheckpoint() {
          throw new Error("simulated hard crash");
        },
      }),
    ).rejects.toThrow("simulated hard crash");
    await expect(
      firstCatalogue.inspectExecution(executionId),
    ).resolves.toMatchObject({
      execution: {
        workflowInput: {
          trigger: "interval",
          configurationReferences: [
            frozenReference,
            "recognition-policy/recovery-policy/1",
          ],
        },
      },
    });

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    database
      .prepare(
        "UPDATE automation_intents SET policy_references_json = ? WHERE id = ?",
      )
      .run(JSON.stringify([currentReference]), enabled.intent.id);
    database.close();
    firstCatalogue.close();

    const checked: string[][] = [];
    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    const restartedWorkflow = recoveryWorkflow(restartedCatalogue, {
      collectionCalls: calls,
      configurationCompatibility: {
        async checkCompatibility(input) {
          checked.push([...input.references]);
          return input.references.includes(frozenReference)
            ? {
                compatible: false,
                reason: "冻结自动化配置版本已变更",
              }
            : { compatible: true };
        },
      },
    });

    await expect(
      restartedWorkflow.resume({ executionId }),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        outcome: "interrupted",
        reason: "冻结自动化配置版本已变更",
        workflowInput: {
          configurationReferences: [
            frozenReference,
            "recognition-policy/recovery-policy/1",
          ],
        },
      },
    });
    expect(checked).toEqual([
      [frozenReference, "recognition-policy/recovery-policy/1"],
    ]);
    expect(calls.count).toBe(1);
    restartedCatalogue.close();
  });

  it("keeps a corrupt frozen input queryable and interrupts it without replaying effects", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const calls = { count: 0 };
    const firstCatalogue = SqliteCatalogue.forProductData(root);
    const firstWorkflow = recoveryWorkflow(firstCatalogue, {
      collectionCalls: calls,
    });
    await expect(
      scanFixtureRegisteredObservedScope(firstWorkflow, {
        directory: "/invalid-input-recovery",
        executionId: "invalid-input-recovery",
        acceptTrusted: true,
        onCheckpoint() {
          throw new Error("simulated hard crash");
        },
      }),
    ).rejects.toThrow("simulated hard crash");
    expect(calls.count).toBe(1);
    firstCatalogue.close();

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    database
      .prepare(
        "UPDATE workflow_executions SET workflow_input_json = ? WHERE id = ?",
      )
      .run(
        JSON.stringify({
          version: "asset-refresh-input/999",
          trigger: "interactive",
          initiatedBy: "interactive",
          acceptTrusted: true,
          configurationReferences: [],
        }),
        "invalid-input-recovery",
      );
    database.close();

    const restartedCatalogue = SqliteCatalogue.forProductData(root);
    const restartedWorkflow = recoveryWorkflow(restartedCatalogue, {
      collectionCalls: calls,
    });
    await expect(
      restartedWorkflow.recoverRunningExecutions(),
    ).resolves.toHaveLength(1);
    await expect(
      restartedWorkflow.inspect("invalid-input-recovery"),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        outcome: "interrupted",
        workflowInputInvalid: {
          reason: "刷新版本化输入版本不受支持",
        },
      },
    });
    expect(calls.count).toBe(1);
    restartedCatalogue.close();
  });

  it("admits only one concurrent SQLite execution for the same Automation Intent", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const first = SqliteCatalogue.forProductData(root);
    await first.createAutomationIntentForTesting({
      id: "intent",
      scope: { observedRootId: "/bounded", relativeScope: "." },
      enabled: true,
      intervalMilliseconds: 1_000,
      workflowInputVersion: "asset-refresh-input/1",
      runInitial: true,
      policyReferences: ["policy"],
      acceptTrusted: false,
    });
    const second = SqliteCatalogue.forProductData(root);
    const results = await Promise.all([
      first.createExecution(
        {
          ...execution(),
          id: "candidate-a",
          automationIntentId: "intent",
          trigger: "interval",
        },
        "2026-07-29T00:00:00.000Z",
      ),
      second.createExecution(
        {
          ...execution(),
          id: "candidate-b",
          automationIntentId: "intent",
          trigger: "interval",
        },
        "2026-07-29T00:00:00.000Z",
      ),
    ]);
    expect(results.toSorted()).toEqual(["skipped", "started"]);
    const inspections = await Promise.all([
      first.inspectExecution("candidate-a"),
      first.inspectExecution("candidate-b"),
    ]);
    expect(inspections.filter((item) => item !== undefined)).toHaveLength(1);
  });

  it("advances one frozen source lineage with immutable facts and rejects a stale refresh", async () => {
    const { catalogue, root } = await createCatalogueWithRoot();
    const traversal = reevaluationWorkflow(catalogue, {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
    });
    await catalogue.createExecution(execution());
    const initialRecord = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/endpoint",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: "{}",
    };
    await retainSourceRecords(catalogue, "execution", [initialRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });
    const originalRelationshipId = (
      await traversal.inspectCurrentCatalogueEntity("persona")
    )?.relationships[0]?.id;
    expect(originalRelationshipId).toBe("relationship");
    await saveCurrentAttentionPreview(catalogue, {
      executionId: "metadata-refresh-preview-owner",
      previewId: "metadata-refresh-sibling-preview",
      accepted: (await catalogue.inspectExecution("execution"))!.accepted!,
    });

    const refreshExecution: WorkflowExecution = {
      ...execution(),
      id: "refresh",
      selection: { directory: "/observed", intent: "metadata-refresh" },
    };
    await catalogue.createExecution(refreshExecution);
    const refreshedRecord = {
      ...initialRecord,
      id: "refreshed-record",
      acquiredAt: "2026-07-30T00:00:00.000Z",
      digest: "new-digest",
    };
    await retainSourceRecords(catalogue, "refresh", [refreshedRecord]);
    const frozen = await catalogue.freezeSourceLineageHeads({
      assetId: "asset",
      sourceAssociation: accepted().recognitionSourceAssociation,
      coverageIds: [refreshedRecord.coverage.id],
    });
    const completed: WorkflowExecution = {
      ...refreshExecution,
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      acceptedAssetId: "asset",
    };
    const submission = {
      assetId: "asset",
      sourceAssociation: accepted().recognitionSourceAssociation,
      sourceRecords: [refreshedRecord],
      expectedLineageHeads: frozen,
      interpretation: {
        ...accepted().proposal.basis.interpretation,
        id: "refresh-interpretation",
        sourceRecordIds: ["refreshed-record"],
        metadata: [
          {
            property: "asset.title",
            sourceSlot: "source.title",
            value: "Refreshed work",
            sourceRecordIds: ["refreshed-record"],
          },
        ],
        entities: [
          {
            ...accepted().entities[0],
            sourceRecordIds: ["refreshed-record"],
          },
        ],
        relationships: [
          {
            participants: [{ entityId: "persona", role: "voice" }],
            subjectRole: "asset",
            type: "asset.contribution" as const,
            sourceSlot: "source.credit.voice",
            sourceRecordIds: ["refreshed-record"],
          },
        ],
        entityMentions: [
          {
            ...accepted().entityMentions[0],
            id: "refreshed-mention",
            sourceRecordIds: ["refreshed-record"],
          },
        ],
        entityResolutionDecisions: [
          {
            ...accepted().entityResolutionDecisions[0],
            id: "refreshed-resolution",
            mentionId: "refreshed-mention",
            sourceRecordIds: ["refreshed-record"],
          },
        ],
      },
    };
    await catalogue.applyMetadataRefresh({
      expectedExecution: await executionBaseline(catalogue, "refresh"),
      execution: completed,
      submission,
    });
    await expect(
      catalogue.inspectChangeImpactPreview("metadata-refresh-sibling-preview"),
    ).resolves.toMatchObject({ status: "stale" });
    await expect(catalogue.inspectExecution("refresh")).resolves.toMatchObject({
      accepted: {
        metadata: [{ property: "asset.title", value: "Refreshed work" }],
        relationships: [{ sourceRecordIds: ["refreshed-record"] }],
        entityMentions: [
          { id: "refreshed-mention", sourceRecordIds: ["refreshed-record"] },
        ],
        entityResolutionDecisions: [
          {
            id: "refreshed-resolution",
            sourceRecordIds: ["refreshed-record"],
          },
        ],
      },
    });
    const refreshed = await catalogue.inspectExecution("refresh");
    expect(refreshed?.accepted?.entityMentions).toHaveLength(1);
    expect(refreshed?.accepted?.entityResolutionDecisions).toHaveLength(1);
    const refreshedRelationshipId = (
      await traversal.inspectCurrentCatalogueEntity("persona")
    )?.relationships[0]?.id;
    expect(refreshedRelationshipId).toBeDefined();
    expect(refreshedRelationshipId).not.toBe(originalRelationshipId);
    const incompleteExecution = {
      ...refreshExecution,
      id: "incomplete-refresh",
    };
    await catalogue.createExecution(incompleteExecution);
    const incompleteRecord = {
      ...refreshedRecord,
      id: "incomplete-record",
      acquiredAt: "2026-07-31T00:00:00.000Z",
      digest: "incomplete-digest",
      coverage: {
        ...refreshedRecord.coverage,
        completeness: "incomplete" as const,
      },
    };
    const incompleteBaseline = await catalogue.freezeSourceLineageHeads({
      assetId: "asset",
      sourceAssociation: accepted().recognitionSourceAssociation,
      coverageIds: [incompleteRecord.coverage.id],
    });
    await retainSourceRecords(catalogue, "incomplete-refresh", [
      incompleteRecord,
    ]);
    await catalogue.applyMetadataRefresh({
      expectedExecution: await executionBaseline(
        catalogue,
        "incomplete-refresh",
      ),
      execution: {
        ...completed,
        id: "incomplete-refresh",
        sourceRecordIds: ["incomplete-record"],
      },
      submission: {
        ...submission,
        sourceRecords: [incompleteRecord],
        expectedLineageHeads: incompleteBaseline,
        interpretation: {
          ...submission.interpretation,
          id: "incomplete-interpretation",
          sourceRecordIds: ["incomplete-record"],
          metadata: [],
          entities: [],
          relationships: [],
          entityMentions: [],
          entityResolutionDecisions: [],
        },
      },
    });
    await expect(
      catalogue.inspectExecution("incomplete-refresh"),
    ).resolves.toMatchObject({
      accepted: {
        metadata: [{ value: "Refreshed work" }],
        relationships: [{ sourceRecordIds: ["refreshed-record"] }],
      },
    });
    expect(
      (
        await traversal.inspectCurrentCatalogueEntity("persona")
      )?.relationships.map(({ id }) => id),
    ).toContain(refreshedRelationshipId);
    await saveCurrentAttentionPreview(catalogue, {
      executionId: "rollback-preview-owner",
      previewId: "rollback-sibling-preview",
      accepted: (await catalogue.inspectExecution("incomplete-refresh"))!
        .accepted!,
    });
    const history = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      history
        .prepare("SELECT 1 FROM entity_mentions WHERE id = ?")
        .get("mention"),
    ).toBeDefined();
    expect(
      history
        .prepare("SELECT 1 FROM entity_resolution_decisions WHERE id = ?")
        .get("resolution"),
    ).toBeDefined();
    expect(
      history
        .prepare(
          `SELECT 1 FROM relationship_retractions
           WHERE relationship_id = ?`,
        )
        .get("relationship"),
    ).toBeUndefined();
    expect(
      history
        .prepare(
          `SELECT 1 FROM relationship_lifecycles
           WHERE predecessor_relationship_id = ?`,
        )
        .get("relationship"),
    ).toBeDefined();
    expect(
      history
        .prepare(
          `SELECT 1 FROM metadata_assertions
           WHERE subject_id = ? AND value = ?`,
        )
        .get("asset", "Work"),
    ).toBeDefined();
    const originalAssertion = history
      .prepare(
        `SELECT id FROM metadata_assertions
         WHERE subject_id = ? AND value = ?`,
      )
      .get("asset", "Work") as { readonly id: number };
    expect(
      history
        .prepare(
          `SELECT 1 FROM metadata_assertion_retractions
           WHERE assertion_id = ?`,
        )
        .get(originalAssertion.id),
    ).toBeUndefined();
    expect(
      history
        .prepare(
          `SELECT 1 FROM metadata_assertion_lifecycles
           WHERE predecessor_assertion_id = ?`,
        )
        .get(originalAssertion.id),
    ).toBeDefined();
    history.close();

    const subjectSelection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [
        {
          subjectId: "asset",
          explanations: [{ path: ["Series", "Episode B"] }],
        },
      ],
      filesystemScopes: [],
    };
    const runningTarget = {
      key: "subject:asset",
      target: { kind: "subject" as const, subjectId: "asset" },
      status: "running" as const,
    };
    const atomicExecution: WorkflowExecution = {
      ...refreshExecution,
      id: "atomic-target-refresh",
      requestedSelection: subjectSelection,
      resolvedSelection: subjectSelection,
      targetDispositions: [runningTarget],
    };
    await catalogue.createExecution(atomicExecution);
    const atomicRecord = {
      ...refreshedRecord,
      id: "atomic-record",
      acquiredAt: "2026-08-01T00:00:00.000Z",
      digest: "atomic-digest",
    };
    const atomicBaseline = await catalogue.freezeSourceLineageHeads({
      assetId: "asset",
      sourceAssociation: accepted().recognitionSourceAssociation,
      coverageIds: [atomicRecord.coverage.id],
    });
    await retainSourceRecords(catalogue, atomicExecution.id, [atomicRecord]);
    const targetCompleted: WorkflowExecution = {
      ...atomicExecution,
      sourceRecordIds: [atomicRecord.id],
      targetDispositions: [{ ...runningTarget, status: "completed" }],
    };
    const injectedFailure = new DatabaseSync(
      path.join(root, "catalogue.sqlite"),
    );
    injectedFailure.exec(`
      CREATE TRIGGER fail_atomic_target_audit
      BEFORE UPDATE ON workflow_executions
      WHEN OLD.id = 'atomic-target-refresh'
      BEGIN
        SELECT RAISE(FAIL, 'injected target audit failure');
      END
    `);
    injectedFailure.close();
    await expect(
      catalogue.applyMetadataRefresh({
        expectedExecution: await executionBaseline(
          catalogue,
          atomicExecution.id,
        ),
        execution: targetCompleted,
        submission: {
          ...submission,
          sourceRecords: [atomicRecord],
          expectedLineageHeads: atomicBaseline,
          interpretation: {
            ...submission.interpretation,
            id: "atomic-interpretation",
            sourceRecordIds: [atomicRecord.id],
            metadata: [
              {
                property: "asset.title",
                sourceSlot: "source.title",
                value: "Must roll back",
                sourceRecordIds: [atomicRecord.id],
              },
            ],
            entityMentions: [
              {
                ...submission.interpretation.entityMentions[0],
                id: "atomic-mention",
                sourceRecordIds: [atomicRecord.id],
              },
            ],
            entityResolutionDecisions: [
              {
                ...submission.interpretation.entityResolutionDecisions[0],
                id: "atomic-resolution",
                mentionId: "atomic-mention",
                sourceRecordIds: [atomicRecord.id],
              },
            ],
          },
        },
      }),
    ).rejects.toThrow("injected target audit failure");
    await expect(
      catalogue.inspectChangeImpactPreview("rollback-sibling-preview"),
    ).resolves.toMatchObject({ status: "awaiting-confirmation" });
    const rollbackProof = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      rollbackProof
        .prepare("SELECT 1 FROM source_refresh_changes WHERE execution_id = ?")
        .get(atomicExecution.id),
    ).toBeUndefined();
    expect(
      rollbackProof
        .prepare("SELECT 1 FROM metadata_assertions WHERE value = ?")
        .get("Must roll back"),
    ).toBeUndefined();
    rollbackProof.exec("DROP TRIGGER fail_atomic_target_audit");
    rollbackProof.close();
    await expect(
      catalogue.inspectExecution(atomicExecution.id),
    ).resolves.toMatchObject({
      execution: { targetDispositions: [{ status: "running" }] },
    });

    const staleParent: WorkflowExecution = {
      ...atomicExecution,
      id: "stale-parent-target",
    };
    await catalogue.createExecution(staleParent);
    const staleParentBaseline = await executionBaseline(
      catalogue,
      staleParent.id,
    );
    await catalogue.transitionExecution(staleParentBaseline, {
      ...staleParent,
      targetDispositions: [
        { ...runningTarget, status: "failed", reason: "other writer" },
      ],
    });
    await expect(
      catalogue.applyMetadataRefresh({
        expectedExecution: staleParentBaseline,
        execution: {
          ...staleParent,
          targetDispositions: [{ ...runningTarget, status: "completed" }],
        },
        submission,
      }),
    ).rejects.toThrow("execution baseline is stale or terminal");

    const staleExecution = { ...refreshExecution, id: "stale" };
    await catalogue.createExecution(staleExecution);
    const staleExecutionBaseline = await executionBaseline(
      catalogue,
      staleExecution.id,
    );
    await expect(
      catalogue.applyMetadataRefresh({
        expectedExecution: staleExecutionBaseline,
        execution: { ...completed, id: "stale" },
        submission,
      }),
    ).rejects.toThrow("stale");

    const completeOmissionExecution = {
      ...refreshExecution,
      id: "complete-omission-refresh",
    };
    await catalogue.createExecution(completeOmissionExecution);
    const completeOmissionRecord = {
      ...refreshedRecord,
      id: "complete-omission-record",
      acquiredAt: "2026-08-02T00:00:00.000Z",
      digest: "complete-omission-digest",
    };
    const completeOmissionBaseline = await catalogue.freezeSourceLineageHeads({
      assetId: "asset",
      sourceAssociation: accepted().recognitionSourceAssociation,
      coverageIds: [completeOmissionRecord.coverage.id],
    });
    await retainSourceRecords(catalogue, completeOmissionExecution.id, [
      completeOmissionRecord,
    ]);
    await catalogue.applyMetadataRefresh({
      expectedExecution: await executionBaseline(
        catalogue,
        completeOmissionExecution.id,
      ),
      execution: {
        ...completed,
        id: completeOmissionExecution.id,
        sourceRecordIds: [completeOmissionRecord.id],
      },
      submission: {
        ...submission,
        sourceRecords: [completeOmissionRecord],
        expectedLineageHeads: completeOmissionBaseline,
        interpretation: {
          ...submission.interpretation,
          id: "complete-omission-interpretation",
          sourceRecordIds: [completeOmissionRecord.id],
          metadata: [],
          entities: [],
          relationships: [],
          entityMentions: [],
          entityResolutionDecisions: [],
        },
      },
    });
    await expect(
      traversal.inspectCurrentCatalogueEntity("persona"),
    ).resolves.toMatchObject({
      entity: { id: "persona" },
      relationships: [],
    });
    catalogue.close();
    const reopenedCatalogue = SqliteCatalogue.forProductData(root);
    const reopenedTraversal = reevaluationWorkflow(reopenedCatalogue, {
      observationVersion: 0,
      sourceVersion: 0,
      expanded: false,
      managedMissing: false,
      omitCover: false,
    });
    await expect(
      reopenedTraversal.inspectCurrentCatalogueEntity("persona"),
    ).resolves.toMatchObject({
      entity: { id: "persona" },
      relationships: [],
    });
    reopenedCatalogue.close();
  });

  it("conditionally applies every projected identity fact and cover without mixing the old current projection", async () => {
    const created = await createCatalogueWithRoot();
    const { root } = created;
    let catalogue = created.catalogue;
    const reusePlan = {
      workItems: [
        {
          key: "directory-interpretation",
          domainBaseline: "domain",
          sourceBaseline: "source",
          informationBaseline: "information",
        },
      ],
    };
    const initialRecord = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "old-digest",
      body: "{}",
    };
    await catalogue.createExecution({ ...execution(), reusePlan });
    await retainSourceRecords(catalogue, "execution", [initialRecord]);
    const initialAccepted = {
      ...accepted(),
      artifactAssociations: accepted().artifactAssociations.map(
        (association) => ({
          ...association,
          sourceAssociationId: "association",
        }),
      ),
    };
    await acceptRecognition(catalogue, {
      execution: { ...acceptedExecution(), reusePlan },
      accepted: initialAccepted,
    });
    await saveCurrentAttentionPreview(catalogue, {
      executionId: "source-enrichment-preview-owner",
      previewId: "source-enrichment-sibling-preview",
      accepted: (await catalogue.inspectExecution("execution"))!.accepted!,
    });
    const supplementExecution = {
      ...execution(),
      id: "supplement",
      stage: "source-records-retained" as const,
      sourceRecordIds: ["supplement-record"],
    };
    const supplementRecord = {
      ...initialRecord,
      id: "supplement-record",
      sourceIdentity: "supplement",
      nativeAddress: "supplement:work",
      coverage: { ...initialRecord.coverage, id: "supplement.complete" },
      digest: "supplement-digest",
    };
    await catalogue.createExecution(supplementExecution);
    await retainSourceRecords(catalogue, "supplement", [supplementRecord]);
    const supplementSourceAssociation = {
      id: "supplement-association",
      subjectId: "asset",
      sourceIdentity: "supplement",
      nativeAddress: "supplement:work",
    };
    await catalogue.applySourceEnrichment({
      expectedExecution: supplementExecution,
      execution: supplementExecution,
      expectedRecognitionBaseline: {
        recognitionSourceAssociationId:
          accepted().recognitionSourceAssociation.id,
        recognitionDecisionId: accepted().recognitionDecision.id,
      },
      assetId: "asset",
      sourceAssociation: supplementSourceAssociation,
      ...sourceAssociationEstablishment({
        ...supplementSourceAssociation,
        sourceRecordIds: [supplementRecord.id],
      }),
      sourceRecords: [supplementRecord],
      interpretation: {
        id: "supplement-interpretation",
        producer: {
          capabilityId: "supplement.enrichment",
          capabilityVersion: "1",
          contractVersion: "1",
        },
        sourceRecordIds: ["supplement-record"],
        sourceIdentity: "supplement",
        sourceAddress: "supplement:work",
        metadata: [
          {
            property: "asset.awards",
            sourceSlot: "supplement.awards",
            value: "Supplement award",
            sourceRecordIds: ["supplement-record"],
          },
        ],
        sourceArtifacts: [],
      },
    });
    await expect(
      catalogue.inspectChangeImpactPreview("source-enrichment-sibling-preview"),
    ).resolves.toMatchObject({ status: "stale" });
    const enrichedBeforeIdentityChange =
      (await catalogue.findAcceptedForDirectory("/observed"))!.accepted;
    const lateEnrichmentExecution = {
      ...execution(),
      id: "late-enrichment",
      stage: "source-records-retained" as const,
      sourceRecordIds: ["late-enrichment-record"],
    };
    const lateEnrichmentRecord = {
      ...initialRecord,
      id: "late-enrichment-record",
      sourceIdentity: "late-supplement",
      nativeAddress: "late-supplement:old-work",
      coverage: {
        ...initialRecord.coverage,
        id: "late-supplement.complete",
      },
      digest: "late-enrichment-digest",
    };
    await catalogue.createExecution(lateEnrichmentExecution);
    await retainSourceRecords(catalogue, "late-enrichment", [
      lateEnrichmentRecord,
    ]);

    const directed = {
      ...execution(),
      id: "directed",
      selection: {
        directory: "/observed",
        intent: "directed-recognition" as const,
      },
    };
    const newRecord = {
      ...initialRecord,
      id: "new-record",
      nativeAddress: "https://source.example/new-work",
      acquisition: {
        ...initialRecord.acquisition,
        requestedAddress: "https://source.example/new-work.json",
      },
      digest: "new-digest",
    };
    const newEntity = {
      id: "new-persona",
      kind: "persona" as const,
      sourceIdentity: "source",
      sourceKey: "new-credit",
      identityNamespace: "source.credit.voice",
      label: "New credited name",
      sourceRecordIds: ["new-record"],
    };
    const newMention = {
      id: "new-mention",
      sourceIdentity: "source",
      field: "voice",
      role: "voice",
      label: "New credited name",
      identityNamespace: "source.credit.voice",
      sourceKey: "new-credit",
      sourceRecordIds: ["new-record"],
    };
    const proposal = {
      id: "new-proposal",
      basis: {
        kind: "source-interpretation" as const,
        interpretation: {
          ...accepted().proposal.basis.interpretation,
          id: "new-interpretation",
          sourceRecordIds: ["new-record"],
          sourceAddress: "https://source.example/new-work",
          metadata: [
            {
              property: "asset.title",
              sourceSlot: "source.title",
              value: "New work",
              sourceRecordIds: ["new-record"],
            },
          ],
          entities: [newEntity],
          entityMentions: [newMention],
          entityResolutionDecisions: [
            {
              id: "new-resolution",
              mentionId: "new-mention",
              entityId: "new-persona",
              rule: "source-field-role-exact" as const,
              sourceRecordIds: ["new-record"],
            },
          ],
          relationships: [
            {
              participants: [{ entityId: "new-persona", role: "voice" }],
              subjectRole: "asset",
              type: "asset.contribution" as const,
              sourceSlot: "source.credit.voice",
              sourceRecordIds: ["new-record"],
              qualifiers: [
                { key: "character", value: "New character" },
                { key: "source.order", value: "0" },
              ],
            },
          ],
          sourceArtifacts: [],
        },
      },
      ruleResults: accepted().proposal.ruleResults,
    };
    await catalogue.createExecution(directed);
    await retainSourceRecords(catalogue, "directed", [newRecord]);
    const directedBaseline = (await catalogue.inspectExecution(directed.id))!
      .execution;
    await catalogue.finishExecutionWithProposal(
      directedBaseline,
      {
        ...directed,
        status: "completed",
        stage: "completed",
        outcome: "proposal",
        proposalId: proposal.id,
        sourceRecordIds: ["new-record"],
      },
      proposal,
    );
    const completeBaseline = await catalogue.freezeChangeImpactBaseline({
      assetId: "asset",
      recognitionSourceAssociationId: "association",
      recognitionDecisionId: "decision",
    });
    const preview: ChangeImpactPreview = {
      version: "change-impact-preview/2",
      id: "preview",
      executionId: "directed",
      assetId: "asset",
      proposal,
      change: { kind: "recognition-supersession", proposal },
      evidenceComparison: {
        observed: [],
        manual: [],
        sourceCandidates: [
          {
            outcome: "accepted",
            sourceIdentity: "source",
            nativeAddress: "https://source.example/new-work",
            sourceRecordIds: ["new-record"],
            ruleResults: proposal.ruleResults,
            explanation: "测试身份更正来源解释",
          },
        ],
        conflicts: [],
      },
      baselines: [
        { key: "source-association", value: "association" },
        { key: "recognition-decision", value: "decision" },
        { key: "source-records", value: "record" },
        { key: "complete-current-projection", value: completeBaseline },
      ],
      current: {
        recognitionState: "recognized",
        recognitionDecisionId: "decision",
        sourceAssociations: enrichedBeforeIdentityChange.sourceAssociations.map(
          ({ sourceIdentity, nativeAddress }) => ({
            sourceIdentity,
            nativeAddress,
          }),
        ),
        recognitionSourceAssociation: {
          sourceIdentity:
            enrichedBeforeIdentityChange.recognitionSourceAssociation
              .sourceIdentity,
          nativeAddress:
            enrichedBeforeIdentityChange.recognitionSourceAssociation
              .nativeAddress,
        },
        metadata: enrichedBeforeIdentityChange.metadata,
        entities: enrichedBeforeIdentityChange.entities ?? [],
        entityMentions: enrichedBeforeIdentityChange.entityMentions ?? [],
        entityResolutionDecisions:
          enrichedBeforeIdentityChange.entityResolutionDecisions ?? [],
        relationships: enrichedBeforeIdentityChange.relationships ?? [],
        artifacts: enrichedBeforeIdentityChange.artifacts,
        locations: enrichedBeforeIdentityChange.locations,
        blobs: enrichedBeforeIdentityChange.blobs,
        artifactRevisions: enrichedBeforeIdentityChange.artifactRevisions,
        artifactAssociations: enrichedBeforeIdentityChange.artifactAssociations,
        primaryCoverArtifactId: "artifact",
      },
      projected: {
        recognitionState: "recognized",
        recognitionDecisionId: "recognition-decision-preview",
        sourceAssociations: [
          {
            sourceIdentity: "supplement",
            nativeAddress: "supplement:work",
          },
          {
            sourceIdentity: "source",
            nativeAddress: "https://source.example/new-work",
          },
        ],
        recognitionSourceAssociation: {
          sourceIdentity: "source",
          nativeAddress: "https://source.example/new-work",
        },
        metadata: [
          ...enrichedBeforeIdentityChange.metadata.filter((assertion) =>
            assertion.sourceRecordIds.includes(supplementRecord.id),
          ),
          ...proposal.basis.interpretation.metadata,
        ],
        entities: [newEntity],
        entityMentions: [newMention],
        entityResolutionDecisions:
          proposal.basis.interpretation.entityResolutionDecisions,
        relationships: [
          {
            id: "new-relationship",
            participants: [
              { entityId: "asset", role: "asset" },
              { entityId: "new-persona", role: "voice" },
            ],
            type: "asset.contribution",
            sourceSlot: "source.credit.voice",
            sourceRecordIds: ["new-record"],
            qualifiers: [
              { key: "character", value: "New character" },
              { key: "source.order", value: "0" },
            ],
          },
        ],
        artifacts: [{ id: "new-cover" }],
        locations: [
          {
            id: "new-cover-location",
            artifactId: "new-cover",
            address: "/managed/new-cover",
            kind: "managed",
          },
        ],
        blobs: [
          {
            digest: "new-cover-digest",
            mediaType: "image/jpeg",
            byteLength: 4,
          },
        ],
        artifactRevisions: [
          {
            id: "new-cover-revision",
            artifactId: "new-cover",
            blobDigest: "new-cover-digest",
          },
        ],
        artifactAssociations: [
          {
            id: "new-cover-association",
            target: { kind: "entity" as const, entityId: "asset" },
            artifactId: "new-cover",
            role: "asset.primary-cover",
            sourceRecordIds: ["new-record"],
          },
        ],
        primaryCoverArtifactId: "new-cover",
      },
      blockingConditions: [],
      status: "awaiting-confirmation",
    };
    await catalogue.saveChangeImpactPreview(preview);
    await catalogue.saveChangeImpactPreview({
      ...preview,
      id: "stale-preview",
    });
    expect(
      (await catalogue.listCurrentAttentionPage({ limit: 10 })).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "change-impact-review",
          changeImpactPreviewId: preview.id,
        }),
        expect.objectContaining({
          kind: "change-impact-review",
          changeImpactPreviewId: "stale-preview",
        }),
      ]),
    );

    const rollbackGuard = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    rollbackGuard.exec(`CREATE TRIGGER fail_change_impact_completion
      BEFORE UPDATE ON change_impact_previews
      WHEN NEW.id = 'preview'
        AND json_extract(NEW.preview_json, '$.status') = 'applied'
      BEGIN
        SELECT RAISE(ABORT, 'forced Change Impact completion failure');
      END`);
    rollbackGuard.close();
    await expect(
      catalogue.applyChangeImpactPreview(changeImpactApplyInput(preview)),
    ).rejects.toThrow();
    await expect(
      catalogue.inspectChangeImpactPreview(preview.id),
    ).resolves.toMatchObject({ status: "awaiting-confirmation" });
    await expect(
      catalogue.inspectChangeImpactPreview("stale-preview"),
    ).resolves.toMatchObject({ status: "awaiting-confirmation" });
    const removeRollbackGuard = new DatabaseSync(
      path.join(root, "catalogue.sqlite"),
    );
    removeRollbackGuard.exec("DROP TRIGGER fail_change_impact_completion");
    removeRollbackGuard.close();

    // 完整更正旅程不得为了 CAS 读取或投影事实写入而静默重新进入旧版原生驱动适配器。
    // 随即恢复探针：其余断言刻意使用原始 SQLite 检查查询作为测试夹具。
    rejectDirectDatabaseQueries();
    await expect(
      catalogue.applyChangeImpactPreview(changeImpactApplyInput(preview)),
    ).resolves.toBe("applied");
    vi.restoreAllMocks();
    catalogue.close();
    catalogue = SqliteCatalogue.forProductData(root);
    await expect(
      catalogue.inspectChangeImpactPreview("stale-preview"),
    ).resolves.toMatchObject({ status: "stale" });
    expect(
      (await catalogue.listCurrentAttentionPage({ limit: 10 })).items,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ changeImpactPreviewId: "stale-preview" }),
      ]),
    );
    await expect(
      catalogue.applySourceEnrichment({
        expectedExecution: lateEnrichmentExecution,
        execution: lateEnrichmentExecution,
        expectedRecognitionBaseline: {
          recognitionSourceAssociationId:
            accepted().recognitionSourceAssociation.id,
          recognitionDecisionId: accepted().recognitionDecision.id,
        },
        assetId: "asset",
        sourceAssociation: {
          id: "late-enrichment-association",
          subjectId: "asset",
          sourceIdentity: "late-supplement",
          nativeAddress: "late-supplement:old-work",
        },
        ...sourceAssociationEstablishment({
          id: "late-enrichment-association",
          subjectId: "asset",
          sourceIdentity: "late-supplement",
          nativeAddress: "late-supplement:old-work",
          sourceRecordIds: [lateEnrichmentRecord.id],
        }),
        sourceRecords: [lateEnrichmentRecord],
        interpretation: {
          id: "late-enrichment-interpretation",
          producer: {
            capabilityId: "late-supplement.enrichment",
            capabilityVersion: "1",
            contractVersion: "1",
          },
          sourceRecordIds: ["late-enrichment-record"],
          sourceIdentity: "late-supplement",
          sourceAddress: "late-supplement:old-work",
          metadata: [
            {
              property: "asset.awards",
              sourceSlot: "late-supplement.awards",
              value: "Award for the old identity",
              sourceRecordIds: ["late-enrichment-record"],
            },
          ],
          sourceArtifacts: [],
        },
      }),
    ).rejects.toThrow("recognition identity baseline is stale");
    await expect(
      catalogue.findAcceptedForDirectory("/observed"),
    ).resolves.toMatchObject({
      accepted: {
        proposal: {
          id: "new-proposal",
          basis: {
            kind: "source-interpretation",
            interpretation: {
              sourceRecordIds: ["new-record"],
            },
          },
        },
        recognitionSourceAssociation: {
          nativeAddress: "https://source.example/new-work",
        },
        sourceAssociations: expect.arrayContaining([
          expect.objectContaining({
            sourceIdentity: "supplement",
            nativeAddress: "supplement:work",
          }),
          expect.objectContaining({
            nativeAddress: "https://source.example/new-work",
          }),
        ]),
        metadata: expect.arrayContaining([
          expect.objectContaining({
            property: "asset.awards",
            sourceSlot: "supplement.awards",
            value: "Supplement award",
            sourceRecordIds: ["supplement-record"],
          }),
          expect.objectContaining({
            property: "asset.title",
            sourceSlot: "source.title",
            value: "New work",
            sourceRecordIds: ["new-record"],
          }),
        ]),
        entities: [{ id: "new-persona", label: "New credited name" }],
        entityMentions: [{ id: "new-mention" }],
        entityResolutionDecisions: [{ id: "new-resolution" }],
        relationships: [
          {
            id: "new-relationship",
            qualifiers: [
              { key: "character", value: "New character" },
              { key: "source.order", value: "0" },
            ],
          },
        ],
        artifacts: [{ id: "new-cover" }],
        locations: [{ id: "new-cover-location" }],
        blobs: [{ digest: "new-cover-digest" }],
        artifactRevisions: [{ id: "new-cover-revision" }],
        artifactAssociations: [{ id: "new-cover-association" }],
      },
    });
    const replaced = await catalogue.findAcceptedForDirectory("/observed");
    expect(replaced?.accepted.sourceAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIdentity: "supplement",
        }),
      ]),
    );
    expect(replaced?.accepted.sourceAssociations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIdentity: "late-supplement",
        }),
      ]),
    );
    expect(replaced?.accepted.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "Supplement award",
        }),
      ]),
    );
    expect(replaced?.accepted.metadata).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "Award for the old identity",
        }),
      ]),
    );
    await expect(
      catalogue.findReusableOrdinaryScan({
        plan: reusePlan,
        availableCompatibility: {
          workflowVersion: "asset-refresh/2",
          policyVersion: "legacy",
          capabilityCoordinates: [],
        },
      }),
    ).resolves.toBeUndefined();
    const history = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      history
        .prepare("SELECT 1 FROM source_associations WHERE id = ?")
        .get("association"),
    ).toBeDefined();
    expect(
      history
        .prepare("SELECT 1 FROM recognition_decisions WHERE id = ?")
        .get("decision"),
    ).toBeDefined();
    expect(
      history
        .prepare(
          `SELECT 1 FROM recognition_decision_supersessions
           WHERE predecessor_decision_id = ?`,
        )
        .get("decision"),
    ).toBeDefined();
    expect(
      history.prepare("SELECT 1 FROM artifacts WHERE id = ?").get("artifact"),
    ).toBeDefined();
    expect(
      history
        .prepare(
          `SELECT 1 FROM artifact_association_supersessions
           WHERE predecessor_association_id = ?`,
        )
        .get("artifact-association"),
    ).toBeDefined();
    expect(
      history
        .prepare("SELECT 1 FROM entity_mentions WHERE id = ?")
        .get("mention"),
    ).toBeDefined();
    history.close();
    await expect(
      catalogue.applyChangeImpactPreview(
        changeImpactApplyInput({ ...preview, id: "stale-preview" }),
      ),
    ).resolves.toBe("stale");
    await expect(
      catalogue.inspectChangeImpactPreview("stale-preview"),
    ).resolves.toMatchObject({ status: "stale" });
    expect(
      (await catalogue.listCurrentAttentionPage({ limit: 10 })).items,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ changeImpactPreviewId: "stale-preview" }),
      ]),
    );
    await catalogue.saveChangeImpactPreview({
      ...preview,
      id: "rejected-preview",
    });
    await expect(
      catalogue.rejectChangeImpactPreview({
        previewId: "rejected-preview",
        rejectedBy: "change-impact-reviewer",
      }),
    ).resolves.toBe("rejected");
    expect(
      (await catalogue.listCurrentAttentionPage({ limit: 10 })).items,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ changeImpactPreviewId: "rejected-preview" }),
      ]),
    );
    await expect(
      catalogue.applyChangeImpactPreview(
        changeImpactApplyInput({ ...preview, id: "rejected-preview" }),
      ),
    ).resolves.toBe("stale");
    await expect(
      catalogue.findAcceptedForDirectory("/observed"),
    ).resolves.toMatchObject({
      accepted: {
        recognitionSourceAssociation: {
          nativeAddress: "https://source.example/new-work",
        },
        metadata: expect.arrayContaining([
          expect.objectContaining({ value: "Supplement award" }),
          expect.objectContaining({ value: "New work" }),
        ]),
      },
    });

    const current = await catalogue.findAcceptedForDirectory("/observed");
    if (current === undefined) throw new Error("missing current asset");
    const reverseExecution: WorkflowExecution = {
      ...execution(),
      id: "reverse",
      selection: {
        directory: "/observed",
        intent: "directed-recognition",
      },
    };
    const reverseRecord = {
      ...initialRecord,
      id: "reverse-record",
      acquiredAt: "2026-08-01T00:00:00.000Z",
      digest: "reverse-digest",
    };
    const reverseProposal = {
      ...accepted().proposal,
      id: "reverse-proposal",
      basis: {
        kind: "source-interpretation" as const,
        interpretation: {
          ...accepted().proposal.basis.interpretation,
          id: "reverse-interpretation",
          sourceRecordIds: ["reverse-record"],
          metadata: [
            {
              property: "asset.title",
              sourceSlot: "source.title",
              value: "Work again",
              sourceRecordIds: ["reverse-record"],
            },
          ],
          sourceArtifacts: [],
          entities: [],
          entityMentions: [],
          entityResolutionDecisions: [],
          relationships: [],
        },
      },
    };
    await catalogue.createExecution(reverseExecution);
    await retainSourceRecords(catalogue, "reverse", [reverseRecord]);
    const reverseExecutionBaseline = (await catalogue.inspectExecution(
      reverseExecution.id,
    ))!.execution;
    await catalogue.finishExecutionWithProposal(
      reverseExecutionBaseline,
      {
        ...reverseExecution,
        status: "completed",
        stage: "completed",
        outcome: "proposal",
        proposalId: "reverse-proposal",
        sourceRecordIds: ["reverse-record"],
      },
      reverseProposal,
    );
    const reverseBaseline = await catalogue.freezeChangeImpactBaseline({
      assetId: "asset",
      recognitionSourceAssociationId:
        current.accepted.recognitionSourceAssociation.id,
      recognitionDecisionId: current.accepted.recognitionDecision.id,
    });
    const currentProjection = {
      sourceAssociations: current.accepted.sourceAssociations.map(
        ({ sourceIdentity, nativeAddress }) => ({
          sourceIdentity,
          nativeAddress,
        }),
      ),
      recognitionSourceAssociation: {
        sourceIdentity:
          current.accepted.recognitionSourceAssociation.sourceIdentity,
        nativeAddress:
          current.accepted.recognitionSourceAssociation.nativeAddress,
      },
      metadata: current.accepted.metadata,
      entities: current.accepted.entities ?? [],
      entityMentions: current.accepted.entityMentions ?? [],
      entityResolutionDecisions:
        current.accepted.entityResolutionDecisions ?? [],
      relationships: current.accepted.relationships ?? [],
      artifacts: current.accepted.artifacts,
      locations: current.accepted.locations,
      blobs: current.accepted.blobs,
      artifactRevisions: current.accepted.artifactRevisions,
      artifactAssociations: current.accepted.artifactAssociations,
      primaryCoverArtifactId: "new-cover",
    };
    const reversePreview: ChangeImpactPreview = {
      version: "change-impact-preview/2",
      id: "reverse-preview",
      executionId: "reverse",
      assetId: "asset",
      proposal: reverseProposal,
      change: {
        kind: "recognition-supersession",
        proposal: reverseProposal,
      },
      evidenceComparison: {
        observed: [],
        manual: [],
        sourceCandidates: [
          {
            outcome: "accepted",
            sourceIdentity: "source",
            nativeAddress: "https://source.example/work",
            sourceRecordIds: ["reverse-record"],
            ruleResults: reverseProposal.ruleResults,
            explanation: "测试身份回退来源解释",
          },
        ],
        conflicts: [],
      },
      baselines: [
        {
          key: "source-association",
          value: current.accepted.recognitionSourceAssociation.id,
        },
        {
          key: "recognition-decision",
          value: current.accepted.recognitionDecision.id,
        },
        {
          key: "source-records",
          value: current.accepted.proposal.basis.interpretation.sourceRecordIds
            .toSorted()
            .join(","),
        },
        { key: "complete-current-projection", value: reverseBaseline },
      ],
      current: currentProjection,
      projected: {
        ...currentProjection,
        sourceAssociations: currentProjection.sourceAssociations.map(
          (association) =>
            association.nativeAddress ===
            current.accepted.recognitionSourceAssociation.nativeAddress
              ? {
                  sourceIdentity: "source",
                  nativeAddress: "https://source.example/work",
                }
              : association,
        ),
        recognitionSourceAssociation: {
          sourceIdentity: "source",
          nativeAddress: "https://source.example/work",
        },
        metadata: [
          ...current.accepted.metadata.filter((assertion) =>
            assertion.sourceRecordIds.includes(supplementRecord.id),
          ),
          ...reverseProposal.basis.interpretation.metadata,
        ],
      },
      blockingConditions: [],
      status: "awaiting-confirmation",
    };
    await catalogue.saveChangeImpactPreview(reversePreview);
    await expect(
      catalogue.applyChangeImpactPreview(
        changeImpactApplyInput(reversePreview),
      ),
    ).resolves.toBe("applied");
    await expect(
      catalogue.freezeSourceLineageHeads({
        assetId: "asset",
        sourceAssociation: {
          ...current.accepted.recognitionSourceAssociation,
          sourceIdentity: "source",
          nativeAddress: "https://source.example/work",
        },
        coverageIds: ["complete"],
      }),
    ).resolves.toEqual([
      {
        sourceIdentity: "source",
        nativeAddress: "https://source.example/work",
        coverageId: "complete",
        sourceRecordId: "reverse-record",
      },
    ]);
  });

  it("atomically finishes an identity-change proposal with its Change Impact Preview", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const running = {
      ...execution(),
      id: "atomic-change-execution",
      sourceRecordIds: ["record"],
    };
    const proposal = {
      ...accepted().proposal,
      id: "atomic-change-proposal",
    };
    const preview = {
      version: "change-impact-preview/2" as const,
      id: "atomic-change-preview",
      executionId: running.id,
      assetId: "asset",
      proposal,
      change: { kind: "recognition-supersession" as const, proposal },
      evidenceComparison: {
        observed: [],
        manual: [],
        sourceCandidates: [
          {
            outcome: "accepted" as const,
            sourceIdentity: "source",
            nativeAddress: "https://source.example/projected",
            sourceRecordIds: ["record"],
            ruleResults: proposal.ruleResults,
            explanation: "测试身份更正来源解释",
          },
        ],
        conflicts: [],
      },
      baselines: [],
      current: {
        sourceAssociations: [
          {
            sourceIdentity: "source",
            nativeAddress: "https://source.example/current",
          },
        ],
        recognitionSourceAssociation: {
          sourceIdentity: "source",
          nativeAddress: "https://source.example/current",
        },
        metadata: [],
        entities: [],
        entityMentions: [],
        entityResolutionDecisions: [],
        relationships: [],
        artifacts: [],
        locations: [],
        blobs: [],
        artifactRevisions: [],
        artifactAssociations: [],
      },
      projected: {
        sourceAssociations: [
          {
            sourceIdentity: "source",
            nativeAddress: "https://source.example/projected",
          },
        ],
        recognitionSourceAssociation: {
          sourceIdentity: "source",
          nativeAddress: "https://source.example/projected",
        },
        metadata: [],
        entities: [],
        entityMentions: [],
        entityResolutionDecisions: [],
        relationships: [],
        artifacts: [],
        locations: [],
        blobs: [],
        artifactRevisions: [],
        artifactAssociations: [],
      },
      blockingConditions: [],
      status: "awaiting-confirmation" as const,
    } satisfies ChangeImpactPreview;
    const finished = {
      ...running,
      status: "completed" as const,
      stage: "completed" as const,
      outcome: "proposal" as const,
      proposalId: proposal.id,
    };
    await catalogue.createExecution(running);
    await retainSourceRecords(catalogue, running.id, [sourceRecord()]);
    const runningBaseline = (await catalogue.inspectExecution(running.id))!
      .execution;
    await catalogue.saveChangeImpactPreview({
      ...preview,
      executionId: "existing-preview-owner",
      proposal: { ...proposal, id: "existing-preview-proposal" },
    });

    await expect(
      catalogue.finishExecutionWithChangeImpactPreview({
        expectedExecution: runningBaseline,
        execution: finished,
        proposal,
        preview,
      }),
    ).rejects.toThrow("UNIQUE constraint failed");
    const rolledBack = await catalogue.inspectExecution(running.id);
    expect(rolledBack?.execution.status).toBe("running");
    expect(rolledBack?.execution.proposalId).toBeUndefined();
    expect(rolledBack?.proposal).toBeUndefined();
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM recognition_proposals WHERE id = ?",
        )
        .get(proposal.id),
    ).toEqual({ count: 0 });
    expect(
      await catalogue.inspectChangeImpactPreview(preview.id),
    ).toMatchObject({
      executionId: "existing-preview-owner",
      proposal: { id: "existing-preview-proposal" },
    });

    const committedPreview = {
      ...preview,
      id: "committed-change-preview",
    };
    await catalogue.finishExecutionWithChangeImpactPreview({
      expectedExecution: runningBaseline,
      execution: finished,
      proposal,
      preview: committedPreview,
    });

    await expect(catalogue.inspectExecution(running.id)).resolves.toMatchObject(
      {
        execution: {
          status: "completed",
          outcome: "proposal",
          proposalId: proposal.id,
        },
        proposal: { id: proposal.id },
      },
    );
    await expect(
      catalogue.inspectChangeImpactPreview(committedPreview.id),
    ).resolves.toEqual(committedPreview);
    database.close();
  });

  it("makes only the durable source-record checkpoint available to a later catalogue instance", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const first = SqliteCatalogue.forProductData(root);
    const checkpoint: WorkflowExecution = {
      ...execution(),
      stage: "source-records-retained",
      sourceRecordIds: ["record"],
    };
    await first.createExecution(execution());
    await retainSourceRecords(first, "execution", [
      {
        id: "record",
        sourceIdentity: "source",
        nativeAddress: "https://source.example/work",
        mediaType: "application/json",
        acquiredAt: "2026-07-29T00:00:00.000Z",
        acquisition: {
          requestedAddress: "https://source.example/endpoint",
          method: "GET",
          authorized: false,
        },
        coverage: {
          id: "complete",
          completeness: "complete",
          authority: "official",
        },
        digest: "digest",
        body: "{}",
      },
    ]);
    const retainedBaseline = (await first.inspectExecution("execution"))!
      .execution;
    await first.finishExecution(retainedBaseline, checkpoint);

    const laterProcess = SqliteCatalogue.forProductData(root);
    await expect(
      laterProcess.inspectExecution("execution"),
    ).resolves.toMatchObject({
      execution: {
        status: "running",
        stage: "source-records-retained",
        sourceRecordIds: ["record"],
      },
      sourceRecords: [{ id: "record", body: "{}" }],
    });
  });

  it("persists acquisition and managed-cover effect references across a new catalogue process and rejects terminal reopening", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const first = SqliteCatalogue.forProductData(root);
    const initial = execution();
    await first.createExecution(initial);
    const acquired: WorkflowExecution = {
      ...initial,
      stage: "cover-acquired",
      coverAcquisition: {
        candidateId: "cover",
        sourceRecordId: "record",
        stagedReference: "/managed/staging/cover",
        digest: "digest",
        mediaType: "image/jpeg",
      },
    };
    await first.transitionExecution(initial, acquired);
    const later = SqliteCatalogue.forProductData(root);
    await expect(later.inspectExecution(initial.id)).resolves.toMatchObject({
      execution: {
        stage: "cover-acquired",
        coverAcquisition: { stagedReference: "/managed/staging/cover" },
      },
    });
    const stored: WorkflowExecution = {
      ...acquired,
      stage: "cover-stored",
      managedCover: {
        candidateId: "cover",
        blob: { digest: "digest", mediaType: "image/jpeg", byteLength: 4 },
        location: { address: "/managed/blob" },
      },
    };
    await later.transitionExecution(acquired, stored);
    const terminal = {
      ...stored,
      status: "completed" as const,
      stage: "completed" as const,
      outcome: "accepted" as const,
    };
    await later.transitionExecution(stored, terminal);
    await expect(later.transitionExecution(terminal, terminal)).rejects.toThrow(
      "terminal",
    );
  });

  it("persists an open information requirement and generic artifact checkpoints across processes", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const first = SqliteCatalogue.forProductData(root);
    const initial: WorkflowExecution = {
      ...execution(),
      id: "generic-artifact",
      plannedAssetId: "planned-generic-asset",
      selection: {
        directory: "/observed",
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.body", necessity: "optional" }],
          artifactRoles: [
            {
              role: "fanbox.attachment.future-material",
              necessity: "required",
              maximum: 2,
            },
          ],
          relationshipTypes: [],
        },
      },
    };
    await first.createExecution(initial);
    const acquired: WorkflowExecution = {
      ...initial,
      stage: "source-artifacts-acquired",
      sourceArtifactAcquisitions: [
        {
          candidateId: "attachment",
          sourceRecordId: "record",
          role: "fanbox.attachment.future-material",
          stagedReference: "/managed/staging/attachment",
          digest: "attachment-digest",
          mediaType: "application/octet-stream",
        },
      ],
    };
    await first.transitionExecution(initial, acquired);

    const later = SqliteCatalogue.forProductData(root);
    await expect(later.inspectExecution(initial.id)).resolves.toMatchObject({
      execution: {
        selection: {
          informationRequirement: {
            metadataUsageContext: "asset.ordinary",
            metadata: [{ property: "asset.body", necessity: "optional" }],
            artifactRoles: [
              {
                role: "fanbox.attachment.future-material",
                necessity: "required",
                maximum: 2,
              },
            ],
          },
        },
        stage: "source-artifacts-acquired",
        plannedAssetId: "planned-generic-asset",
        sourceArtifactAcquisitions: [
          {
            candidateId: "attachment",
            role: "fanbox.attachment.future-material",
          },
        ],
      },
    });
  });

  it("persists the complete pending source-enrichment intent across a SQLite restart", async () => {
    const root = await preparedCatalogueRoot();
    cleanup.push(root);
    const first = SqliteCatalogue.forProductData(root);
    const initial = execution();
    await first.createExecution(initial);
    const pending: WorkflowExecution = {
      ...initial,
      acceptedAssetId: "asset",
      sourceEnrichments: [
        {
          key: "source-enrichment:asset:supplement",
          subjectId: "asset",
          stage: "source-artifact-acquired",
          subject: {
            subjectId: "asset",
            recognitionSourceAssociation: {
              id: "recognition-association",
              subjectId: "asset",
              sourceIdentity: "source",
              nativeAddress: "source:work",
              proposalId: "recognition-proposal",
            },
            recognitionDecisionId: "recognition-decision",
            sourceAssociations: [],
            metadata: [],
            metadataSourceRecords: [],
            informationRequirement: {
              metadataUsageContext: "asset.ordinary",
              metadata: [{ property: "asset.awards", necessity: "optional" }],
              artifactRoles: [
                {
                  role: "asset.primary-cover",
                  necessity: "optional",
                  maximum: 1,
                },
              ],
              relationshipTypes: [],
            },
          },
          evidence: {
            kind: "source-association",
            sourceIdentity: "supplement",
            sourceAddress: "supplement:work",
            explanation: "exact supplementary source",
            producer: {
              capabilityId: "supplement.candidate",
              capabilityVersion: "1",
              contractVersion: "1",
            },
          },
          fulfilledArtifactRoles: [],
          sourceAssociation: {
            id: "supplement-association",
            subjectId: "asset",
            sourceIdentity: "supplement",
            nativeAddress: "supplement:work",
            proposalId: "source-enrichment:execution:supplement",
          },
          interpretation: {
            id: "supplement-interpretation",
            producer: {
              capabilityId: "supplement.interpreter",
              capabilityVersion: "1",
              contractVersion: "1",
            },
            sourceRecordIds: ["supplement-record"],
            sourceIdentity: "supplement",
            sourceAddress: "supplement:work",
            metadata: [
              {
                property: "asset.awards",
                sourceSlot: "supplement.awards",
                value: "One award",
                sourceRecordIds: ["supplement-record"],
              },
            ],
            sourceArtifacts: [],
          },
          sourceRecordIds: ["supplement-record"],
          sourceArtifacts: [
            {
              id: "supplement-cover",
              sourceRecordId: "supplement-record",
              subjectId: "asset",
              role: "asset.primary-cover",
              acquisitionReference: "https://source.example/cover.jpg",
              mediaType: "image/jpeg",
            },
          ],
          sourceArtifactAcquisitions: [
            {
              candidateId: "supplement-cover",
              sourceRecordId: "supplement-record",
              subjectId: "asset",
              role: "asset.primary-cover",
              acquisitionReference: "https://source.example/cover.jpg",
              stagedReference: "staged:supplement-cover",
              digest: "supplement-cover-digest",
              mediaType: "image/jpeg",
            },
          ],
        },
      ],
    };
    await first.transitionExecution(initial, pending);
    first.close();

    const restarted = SqliteCatalogue.forProductData(root);
    await expect(restarted.inspectExecution(initial.id)).resolves.toMatchObject(
      {
        execution: {
          acceptedAssetId: "asset",
          sourceEnrichments: [
            {
              stage: "source-artifact-acquired",
              subjectId: "asset",
              evidence: {
                sourceIdentity: "supplement",
                sourceAddress: "supplement:work",
              },
              subject: {
                recognitionSourceAssociation: {
                  id: "recognition-association",
                },
                recognitionDecisionId: "recognition-decision",
                informationRequirement: {
                  metadataUsageContext: "asset.ordinary",
                },
              },
              sourceAssociation: {
                sourceIdentity: "supplement",
                nativeAddress: "supplement:work",
              },
              interpretation: {
                sourceRecordIds: ["supplement-record"],
                metadata: [{ property: "asset.awards", value: "One award" }],
              },
              sourceArtifacts: [
                {
                  id: "supplement-cover",
                  role: "asset.primary-cover",
                  subjectId: "asset",
                },
              ],
              sourceArtifactAcquisitions: [
                {
                  candidateId: "supplement-cover",
                  stagedReference: "staged:supplement-cover",
                },
              ],
            },
          ],
        },
      },
    );
    restarted.close();
  });

  it("resumes only a pending enrichment after SQLite restart when an earlier enrichment is durably failed", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const recognitionRecord = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "recognition-record-digest",
      body: "{}",
    };
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [recognitionRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });

    const acceptedSubject = accepted();
    const informationRequirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [{ property: "asset.awards", necessity: "optional" as const }],
      artifactRoles: [],
      relationshipTypes: [],
    };
    const base = {
      subjectId: "asset",
      subject: {
        subjectId: "asset",
        recognitionSourceAssociation:
          acceptedSubject.recognitionSourceAssociation,
        recognitionDecisionId: acceptedSubject.recognitionDecision.id,
        sourceAssociations: [acceptedSubject.recognitionSourceAssociation],
        metadata: acceptedSubject.metadata,
        metadataSourceRecords: [{ id: "record", sourceIdentity: "source" }],
        informationRequirement,
      },
      fulfilledArtifactRoles: [],
    };
    const pending: WorkflowExecution = {
      ...execution(),
      id: "enrichment-failure-restart",
      workflowInput: {
        version: "asset-refresh-input/1",
        trigger: "interactive",
        initiatedBy: "interactive",
        acceptTrusted: true,
        configurationReferences: [],
      },
      acceptedAssetId: "asset",
      stage: "source-records-retained",
      compatibility: {
        workflowVersion: "asset-refresh/2",
        policyVersion: "enrichment-recovery-policy/1",
        capabilityCoordinates: [
          "enrichment-recovery.collector@1/1",
          "enrichment-recovery.interpreter@1/1",
        ],
      },
      dispositions: [
        {
          key: "source-enrichment:asset:failed-recovery",
          status: "failed",
          reason: "first enrichment collection exploded",
        },
        {
          key: "source-enrichment:asset:surviving-recovery",
          status: "running",
        },
      ],
      sourceEnrichments: [
        {
          ...base,
          key: "source-enrichment:asset:failed-recovery",
          stage: "failed",
          evidence: {
            kind: "source-association",
            sourceIdentity: "failed-recovery-source",
            sourceAddress: "failed-recovery:work",
            explanation: "failed exact source",
            producer: {
              capabilityId: "failed-recovery.candidate",
              capabilityVersion: "1",
              contractVersion: "1",
            },
          },
          sourceRecordIds: [],
          collectionFailures: [],
        },
        {
          ...base,
          key: "source-enrichment:asset:surviving-recovery",
          stage: "candidate-interpreted",
          evidence: {
            kind: "source-association",
            sourceIdentity: "surviving-recovery-source",
            sourceAddress: "surviving-recovery:work",
            explanation: "surviving exact source",
            producer: {
              capabilityId: "surviving-recovery.candidate",
              capabilityVersion: "1",
              contractVersion: "1",
            },
          },
        },
      ],
    };
    await catalogue.createExecution(pending);
    catalogue.close();

    const restarted = SqliteCatalogue.forProductData(root);
    const calls = new Map<string, number>();
    const resumed = await enrichmentCheckpointRecoveryWorkflow(
      restarted,
      calls,
    ).resume({
      executionId: pending.id,
    });

    expect(calls.get("failed-recovery-source") ?? 0).toBe(0);
    expect(calls.get("surviving-recovery-source") ?? 0).toBe(1);
    expect(resumed.execution.outcome).toBe("partially-succeeded");
    expect(resumed.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "source-enrichment:asset:failed-recovery",
          status: "failed",
          reason: "first enrichment collection exploded",
        }),
        expect.objectContaining({
          key: "source-enrichment:asset:surviving-recovery",
          status: "completed",
        }),
      ]),
    );
    expect(resumed.accepted?.sourceAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIdentity: "surviving-recovery-source",
        }),
      ]),
    );
    restarted.close();
  });

  it("persists accepted domain facts and relationship qualifiers through a SQLite restart", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [
      {
        id: "record",
        sourceIdentity: "source",
        nativeAddress: "https://source.example/work",
        mediaType: "application/json",
        acquiredAt: "2026-07-29T00:00:00.000Z",
        acquisition: {
          requestedAddress: "https://source.example/endpoint",
          method: "GET",
          authorized: false,
        },
        coverage: {
          id: "complete",
          completeness: "complete",
          authority: "official",
        },
        digest: "digest",
        body: "{}",
      },
    ]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });

    const inspect = async (candidate: SqliteCatalogue) => {
      await expect(
        candidate.inspectExecution("execution"),
      ).resolves.toMatchObject({
        execution: { outcome: "accepted", acceptedAssetId: "asset" },
        accepted: {
          entity: { kind: "digital-asset" },
          recognitionSourceAssociation: {
            nativeAddress: "https://source.example/work",
          },
          recognitionDecision: { id: "decision" },
          artifactAssociations: [{ role: "asset.primary-cover" }],
          blobs: [{ digest: "digest" }],
          metadata: [
            {
              property: "asset.title",
              qualifiers: [
                {
                  key: "rating.source-label",
                  value: "Internet Movie Database",
                },
                { key: "rating.unit", value: "score" },
              ],
            },
          ],
          entities: [
            { kind: "persona", identityNamespace: "source.credit.voice" },
          ],
          entityMentions: [
            { id: "mention", label: "Credited name", role: "voice" },
          ],
          entityResolutionDecisions: [
            { mentionId: "mention", entityId: "persona" },
          ],
          relationships: [
            {
              participants: [
                { entityId: "asset", role: "asset" },
                { entityId: "persona", role: "voice" },
              ],
              qualifiers: [{ key: "credit-note", value: "official" }],
            },
          ],
        },
      });
    };
    await inspect(catalogue);

    catalogue.close();
    const restarted = SqliteCatalogue.forProductData(root);
    await inspect(restarted);
    restarted.close();
  });

  it("persists source-record recognition evidence without treating search records as projected-subject lineage", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    await catalogue.createExecution(execution());
    const sourceRecord = (
      id: string,
      nativeAddress: string,
      coverageId: string,
    ) => ({
      id,
      sourceIdentity: "source",
      nativeAddress,
      mediaType: "application/json",
      acquiredAt: "2026-07-31T00:00:00.000Z",
      acquisition: {
        requestedAddress: `https://source.example/${id}`,
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: coverageId,
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: `${id}-digest`,
      body: "{}",
    });
    await retainSourceRecords(catalogue, "execution", [
      sourceRecord("search-record", "source-search:Work:2026", "search"),
      sourceRecord("record", "https://source.example/work", "complete"),
    ]);
    const base = accepted();
    const evidenceReferences = [
      { kind: "source-record" as const, sourceRecordId: "search-record" },
      { kind: "source-record" as const, sourceRecordId: "record" },
    ];
    const proposal = {
      ...base.proposal,
      basis: {
        kind: "source-interpretation" as const,
        interpretation: {
          ...base.proposal.basis.interpretation,
          recognitionEvidenceReferences: evidenceReferences,
        },
      },
      ruleResults: base.proposal.ruleResults.map((result) => ({
        ...result,
        evidenceReferences,
      })),
    };
    const acceptedWithEvidence: AcceptedRecognition = {
      ...base,
      proposal,
      recognitionSourceAssociation: base.recognitionSourceAssociation,
      sourceAssociations: base.sourceAssociations,
      recognitionDecision: {
        ...base.recognitionDecision,
        proposalId: proposal.id,
        acceptedRuleResults: proposal.ruleResults,
      },
    };
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: acceptedWithEvidence,
    });
    catalogue.close();

    const restarted = SqliteCatalogue.forProductData(root);
    await expect(
      restarted.inspectExecution("execution"),
    ).resolves.toMatchObject({
      proposal: {
        basis: {
          interpretation: {
            sourceRecordIds: ["record"],
            recognitionEvidenceReferences: evidenceReferences,
          },
        },
        ruleResults: [{ evidenceReferences }],
      },
    });
    restarted.close();
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"), {
      readOnly: true,
    });
    expect(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM source_lineage_heads WHERE source_record_id = 'search-record'",
          )
          .get() as { readonly count: number }
      ).count,
    ).toBe(0);
    database.close();
  });

  it("persists sourced metadata on its resolved Entity rather than the accepted asset", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const base = accepted();
    const work = {
      id: "work-entity",
      kind: "entity" as const,
      sourceIdentity: "source",
      sourceKey: "work",
      identityNamespace: "source.work",
      label: "Work entity",
      sourceRecordIds: ["record"],
    };
    const workTitleCandidate = {
      subjectId: work.id,
      property: "work.title",
      sourceSlot: "source.work.title",
      value: "Work entity",
      sourceRecordIds: ["record"],
    };
    const fact: AcceptedRecognition = {
      ...base,
      proposal: {
        ...base.proposal,
        interpretation: {
          ...base.proposal.basis.interpretation,
          metadata: [
            ...base.proposal.basis.interpretation.metadata,
            workTitleCandidate,
          ],
          entities: [
            ...(base.proposal.basis.interpretation.entities ?? []),
            work,
          ],
        },
      },
      metadata: [
        ...base.metadata,
        {
          ...workTitleCandidate,
          target: { kind: "entity" as const, entityId: work.id },
        },
      ],
      entities: [...(base.entities ?? []), work],
    };
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [
      {
        id: "record",
        sourceIdentity: "source",
        nativeAddress: "https://source.example/work",
        mediaType: "application/json",
        acquiredAt: "2026-07-29T00:00:00.000Z",
        acquisition: {
          requestedAddress: "https://source.example/endpoint",
          method: "GET",
          authorized: false,
        },
        coverage: {
          id: "complete",
          completeness: "complete",
          authority: "official",
        },
        digest: "work-digest",
        body: "{}",
      },
    ]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: fact,
    });
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      database
        .prepare(
          "SELECT subject_id FROM metadata_assertions WHERE property = 'work.title'",
        )
        .get(),
    ).toEqual({ subject_id: "work-entity" });
    database.close();
  });

  it("keeps a Bangumi episode's shared Work facts within its applicable source lineage", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const work = {
      id: "shared-work",
      kind: "entity" as const,
      sourceIdentity: "bangumi",
      sourceKey: "243981",
      identityNamespace: "bangumi.subject",
      label: "Shared work",
    };
    const series = {
      id: "shared-series",
      kind: "entity" as const,
      sourceIdentity: "bangumi",
      sourceKey: "400602",
      identityNamespace: "bangumi.subject",
      label: "Shared series",
    };
    const otherSeries = {
      id: "other-series",
      kind: "entity" as const,
      sourceIdentity: "bangumi",
      sourceKey: "515759",
      identityNamespace: "bangumi.subject",
      label: "Other series",
    };
    const sourceRecord = (id: string, nativeAddress: string) => ({
      id,
      sourceIdentity: "bangumi",
      nativeAddress,
      mediaType: "application/json",
      acquiredAt: "2026-07-30T00:00:00.000Z",
      acquisition: {
        requestedAddress: `${nativeAddress}.json`,
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "work",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: `${id}-digest`,
      body: "{}",
    });
    const acceptedWork = (
      assetId: string,
      recordId: string,
      nativeAddress: string,
      value = "Shared work",
      otherLineage = false,
    ): AcceptedRecognition => {
      const participant = otherLineage ? otherSeries : series;
      const artifactId = otherLineage
        ? "other-work-cover-artifact"
        : "shared-work-cover-artifact";
      const metadata = {
        subjectId: work.id,
        property: "bangumi.subject.name",
        sourceSlot: "bangumi.subject.name",
        value,
        sourceRecordIds: [recordId],
      };
      const relationship = {
        id: otherLineage ? "other-work-series" : "shared-work-series",
        sourceSubjectId: work.id,
        participants: [
          { entityId: work.id, role: "bangumi.subject.predecessor" },
          { entityId: participant.id, role: "bangumi.subject.sequel" },
        ],
        type: "bangumi.subject.related",
        sourceSlot: "bangumi.subject.related",
        sourceRecordIds: [recordId],
      };
      const cover = {
        id: otherLineage ? "other-work-cover" : "shared-work-cover",
        target: { kind: "entity" as const, entityId: work.id },
        artifactId,
        role: "asset.primary-cover",
        sourceRecordIds: [recordId],
      };
      const unprovenancedCover = {
        id: "unprovenanced-other-work-cover",
        target: { kind: "entity" as const, entityId: work.id },
        artifactId: "unprovenanced-other-work-cover-artifact",
        role: "asset.primary-cover",
        sourceRecordIds: [recordId],
      };
      const covers = [cover, ...(otherLineage ? [unprovenancedCover] : [])];
      const artifactIds = covers.map((item) => item.artifactId);
      const proposal = {
        id: `proposal-${assetId}`,
        basis: {
          kind: "source-interpretation" as const,
          interpretation: {
            id: `interpretation-${assetId}`,
            producer: {
              capabilityId: "shared-work-interpreter",
              capabilityVersion: "1",
              contractVersion: "1",
            },
            sourceRecordIds: [recordId],
            sourceIdentity: "bangumi",
            sourceAddress: nativeAddress,
            metadata: [metadata],
            sourceArtifacts: [],
            entities: [
              { ...work, sourceRecordIds: [recordId] },
              { ...participant, sourceRecordIds: [recordId] },
            ],
            entityMentions: [],
            entityResolutionDecisions: [],
            relationships: [relationship],
          },
        },
        ruleResults: [
          {
            capabilityId: "shared-work-recognizer",
            capabilityVersion: "1",
            ruleId: "exact",
            ruleVersion: "1",
            outcome: "satisfied" as const,
            explanation: "exact",
            evidence: [],
          },
        ],
      };
      return {
        proposal,
        entity: { id: assetId, kind: "digital-asset" },
        recognitionSourceAssociation: {
          id: `source-association-${assetId}`,
          subjectId: assetId,
          sourceIdentity: "bangumi",
          nativeAddress,
          proposalId: proposal.id,
        },
        sourceAssociations: [
          {
            id: `source-association-${assetId}`,
            subjectId: assetId,
            sourceIdentity: "bangumi",
            nativeAddress,
            proposalId: proposal.id,
          },
        ],
        recognitionDecision: {
          id: `recognition-decision-${assetId}`,
          proposalId: proposal.id,
          assetId,
          acceptedRuleResults: proposal.ruleResults,
        },
        artifacts: artifactIds.map((id) => ({ id })),
        locations: artifactIds.map((id) => ({
          id: `${id}-location`,
          artifactId: id,
          address: `/managed/${id}`,
          kind: "managed" as const,
        })),
        blobs: artifactIds.map((id) => ({
          digest: `${id}-digest`,
          mediaType: "image/jpeg",
          byteLength:
            id === "unprovenanced-other-work-cover-artifact"
              ? 6
              : otherLineage
                ? 5
                : 4,
        })),
        artifactRevisions: artifactIds.map((id) => ({
          id: `${id}-revision`,
          artifactId: id,
          blobDigest: `${id}-digest`,
        })),
        artifactAssociations: covers,
        metadata: [
          {
            ...metadata,
            target: { kind: "entity" as const, entityId: work.id },
          },
        ],
        entities: [
          { ...work, sourceRecordIds: [recordId] },
          { ...participant, sourceRecordIds: [recordId] },
        ],
        entityMentions: [],
        entityResolutionDecisions: [],
        relationships: [relationship],
      };
    };
    const firstRecord = sourceRecord(
      "shared-record-1",
      "https://api.bgm.tv/v0/episodes/831401",
    );
    const siblingRecord = sourceRecord(
      "shared-record-1-sibling",
      "https://api.bgm.tv/v0/episodes/831401",
    );
    const secondRecord = sourceRecord(
      "shared-record-2",
      "https://api.bgm.tv/v0/episodes/831401",
    );
    const otherRecord = sourceRecord(
      "other-record",
      "https://api.bgm.tv/v0/episodes/831402",
    );
    for (const [index, [record, accepted]] of [
      [
        firstRecord,
        acceptedWork("asset-1", firstRecord.id, firstRecord.nativeAddress),
      ],
      [
        siblingRecord,
        acceptedWork(
          "asset-1-sibling",
          siblingRecord.id,
          siblingRecord.nativeAddress,
        ),
      ],
      [
        secondRecord,
        acceptedWork("asset-2", secondRecord.id, secondRecord.nativeAddress),
      ],
      [
        otherRecord,
        acceptedWork(
          "asset-3",
          otherRecord.id,
          otherRecord.nativeAddress,
          "Other work",
          true,
        ),
      ],
    ].entries()) {
      const executionId = `shared-work-execution-${index + 1}`;
      await catalogue.createExecution({ ...execution(), id: executionId });
      await retainSourceRecords(catalogue, executionId, [record]);
      await acceptRecognition(catalogue, {
        execution: {
          ...acceptedExecution(),
          id: executionId,
          proposalId: accepted.proposal.id,
          acceptedAssetId: accepted.entity.id,
        },
        accepted,
      });
    }

    await expect(
      catalogue.inspectExecution("shared-work-execution-1"),
    ).resolves.toMatchObject({
      sourceRecords: [{ id: firstRecord.id }],
      accepted: {
        metadata: [
          expect.objectContaining({
            target: { kind: "entity", entityId: work.id },
            property: "bangumi.subject.name",
            value: "Shared work",
          }),
        ],
        relationships: [
          expect.objectContaining({
            participants: expect.arrayContaining([
              { entityId: work.id, role: "bangumi.subject.predecessor" },
              { entityId: series.id, role: "bangumi.subject.sequel" },
            ]),
            type: "bangumi.subject.related",
          }),
        ],
        entities: [
          expect.objectContaining({ id: series.id }),
          expect.objectContaining({ id: work.id }),
        ],
        artifacts: [{ id: "shared-work-cover-artifact" }],
        artifactAssociations: [
          expect.objectContaining({
            id: "shared-work-cover",
            artifactId: "shared-work-cover-artifact",
          }),
        ],
        locations: [
          expect.objectContaining({
            id: "shared-work-cover-artifact-location",
          }),
        ],
        artifactRevisions: [
          expect.objectContaining({
            id: "shared-work-cover-artifact-revision",
          }),
        ],
        blobs: [
          expect.objectContaining({
            digest: "shared-work-cover-artifact-digest",
          }),
        ],
      },
    });
    const current = await catalogue.inspectExecution("shared-work-execution-1");
    await expect(
      catalogue.inspectExecution("shared-work-execution-1"),
    ).resolves.toEqual(current);
    expect(current?.accepted?.metadata.map((item) => item.value)).not.toContain(
      "Other work",
    );
    expect(
      current?.accepted?.relationships.flatMap((item) =>
        item.participants.map((participant) => participant.entityId),
      ),
    ).not.toContain(otherSeries.id);
    expect(current?.accepted?.entities.map((item) => item.id)).not.toContain(
      otherSeries.id,
    );
    expect(current?.accepted?.artifacts.map((item) => item.id)).not.toContain(
      "other-work-cover-artifact",
    );
    expect(
      current?.accepted?.artifactAssociations.map((item) => item.id),
    ).not.toContain("other-work-cover");
    expect(
      current?.accepted?.artifactAssociations.map((item) => item.id),
    ).not.toContain("unprovenanced-other-work-cover");
    await expect(
      catalogue.inspectExecution("shared-work-execution-4"),
    ).resolves.toMatchObject({
      sourceRecords: [{ id: otherRecord.id }],
    });

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM metadata_assertions assertion
           JOIN metadata_assertion_lifecycles lifecycle ON lifecycle.assertion_id = assertion.id
           WHERE assertion.subject_id = ? AND assertion.property = ?
             AND assertion.value = ? AND lifecycle.source_slot = ?`,
        )
        .get(
          work.id,
          "bangumi.subject.name",
          "Shared work",
          "bangumi.subject.name",
        ),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM entity_relationships WHERE id = ?",
        )
        .get("shared-work-series"),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM artifact_associations WHERE id = ?",
        )
        .get("shared-work-cover"),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM metadata_assertion_sources source
           JOIN metadata_assertions assertion ON assertion.id = source.assertion_id
           WHERE assertion.subject_id = ? AND assertion.value = ?`,
        )
        .get(work.id, "Shared work"),
    ).toEqual({ count: 3 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM relationship_sources source
           JOIN source_records record ON record.id = source.source_record_id
           WHERE source.relationship_id = ? AND record.native_address = ?`,
        )
        .get("shared-work-series", firstRecord.nativeAddress),
    ).toEqual({ count: 3 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM relationship_sources
           WHERE relationship_id = ? AND source_record_id = ?`,
        )
        .get("shared-work-series", firstRecord.id),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM metadata_assertion_sources source
           JOIN metadata_assertions assertion ON assertion.id = source.assertion_id
           WHERE assertion.subject_id = ? AND assertion.value = ?
             AND source.source_record_id = ?`,
        )
        .get(work.id, "Shared work", firstRecord.id),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM artifact_associations association
           JOIN json_each(association.source_record_ids_json) provenance
           JOIN source_records record ON record.id = provenance.value
           WHERE association.id = ? AND record.native_address = ?`,
        )
        .get("shared-work-cover", firstRecord.nativeAddress),
    ).toEqual({ count: 3 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM source_records WHERE id IN (?, ?, ?)",
        )
        .get(firstRecord.id, siblingRecord.id, secondRecord.id),
    ).toEqual({ count: 3 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM metadata_assertions WHERE subject_id = ? AND value = ?",
        )
        .get(work.id, "Other work"),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("reuses one sourced Entity when separate accepted assets share its exact identity", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const first = accepted();
    const secondRecordId = "record-2";
    const second: AcceptedRecognition = {
      ...first,
      proposal: {
        ...first.proposal,
        id: "proposal-2",
        basis: {
          kind: "source-interpretation",
          interpretation: {
            ...first.proposal.basis.interpretation,
            id: "interpretation-2",
            sourceRecordIds: [secondRecordId],
            sourceAddress: "https://source.example/work-2",
            metadata: first.proposal.basis.interpretation.metadata.map(
              (assertion) => ({
                ...assertion,
                sourceRecordIds: [secondRecordId],
              }),
            ),
            entities: first.proposal.basis.interpretation.entities?.map(
              (entity) => ({
                ...entity,
                sourceRecordIds: [secondRecordId],
              }),
            ),
            entityMentions:
              first.proposal.basis.interpretation.entityMentions.map(
                (mention) => ({
                  ...mention,
                  id: "mention-2",
                  sourceRecordIds: [secondRecordId],
                }),
              ),
            entityResolutionDecisions:
              first.proposal.basis.interpretation.entityResolutionDecisions.map(
                (decision) => ({
                  ...decision,
                  id: "resolution-2",
                  mentionId: "mention-2",
                  sourceRecordIds: [secondRecordId],
                }),
              ),
          },
        },
      },
      entity: { id: "asset-2", kind: "digital-asset" },
      recognitionSourceAssociation: {
        ...first.recognitionSourceAssociation,
        id: "association-2",
        subjectId: "asset-2",
        nativeAddress: "https://source.example/work-2",
        proposalId: "proposal-2",
      },
      sourceAssociations: [
        {
          ...first.recognitionSourceAssociation!,
          id: "association-2",
          subjectId: "asset-2",
          nativeAddress: "https://source.example/work-2",
          proposalId: "proposal-2",
        },
      ],
      recognitionDecision: {
        ...first.recognitionDecision,
        id: "decision-2",
        proposalId: "proposal-2",
        assetId: "asset-2",
      },
      artifacts: [{ id: "artifact-2" }],
      locations: [
        {
          id: "location-2",
          artifactId: "artifact-2",
          address: "/managed/blob-2",
          kind: "managed",
        },
      ],
      artifactRevisions: [
        {
          id: "revision-2",
          artifactId: "artifact-2",
          blobDigest: "digest",
        },
      ],
      artifactAssociations: [
        {
          id: "artifact-association-2",
          target: { kind: "entity" as const, entityId: "asset-2" },
          artifactId: "artifact-2",
          role: "asset.primary-cover",
        },
      ],
      metadata: first.metadata.map((assertion) => ({
        ...assertion,
        target: { kind: "entity" as const, entityId: "asset-2" },
        sourceRecordIds: [secondRecordId],
      })),
      entities: first.entities?.map((entity) => ({
        ...entity,
        sourceRecordIds: [secondRecordId],
      })),
      entityMentions: first.entityMentions?.map((mention) => ({
        ...mention,
        id: "mention-2",
        sourceRecordIds: [secondRecordId],
      })),
      entityResolutionDecisions: first.entityResolutionDecisions?.map(
        (decision) => ({
          ...decision,
          id: "resolution-2",
          mentionId: "mention-2",
          sourceRecordIds: [secondRecordId],
        }),
      ),
      relationships: first.relationships?.map((relationship) => ({
        ...relationship,
        id: "relationship-2",
        participants: relationship.participants.map((participant) => ({
          ...participant,
          entityId:
            participant.entityId === "asset" ? "asset-2" : participant.entityId,
        })),
        sourceRecordIds: [secondRecordId],
      })),
    };

    for (const [index, item] of [first, second].entries()) {
      const executionId = `execution-${index + 1}`;
      await catalogue.createExecution({
        ...execution(),
        id: executionId,
        selection: { directory: `/observed-${index + 1}` },
      });
      const recordId = index === 0 ? "record" : secondRecordId;
      await retainSourceRecords(catalogue, executionId, [
        {
          id: recordId,
          sourceIdentity: "source",
          nativeAddress:
            index === 0
              ? "https://source.example/work"
              : "https://source.example/work-2",
          mediaType: "application/json",
          acquiredAt: "2026-07-29T00:00:00.000Z",
          acquisition: {
            requestedAddress: `https://source.example/endpoint-${index + 1}`,
            method: "GET",
            authorized: false,
          },
          coverage: {
            id: "complete",
            completeness: "complete",
            authority: "official",
          },
          digest: `digest-${index + 1}`,
          body: "{}",
        },
      ]);
      await acceptRecognition(catalogue, {
        execution: {
          ...acceptedExecution(),
          id: executionId,
          proposalId: item.proposal.id,
          acceptedAssetId: item.entity.id,
        },
        accepted: item,
      });
    }

    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    expect(
      database
        .prepare("SELECT count(*) AS count FROM sourced_entities WHERE id = ?")
        .get("persona"),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM entity_relationship_participants WHERE entity_id = ?",
        )
        .get("persona"),
    ).toEqual({ count: 2 });
    database.close();
  });

  it("rolls back every accepted fact if a catalogue write fails", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    // 适配器首次打开时会检查已审核模式。随后测试在 SQLite 边界注入失败，
    // 以证明应用层现有即时事务仍会回滚每条事实。
    await catalogue.listExecutions();
    const failure = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      failure.exec(
        "CREATE TRIGGER reject_artifacts BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'planned catalogue failure'); END",
      );
    } finally {
      failure.close();
    }
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [
      {
        id: "record",
        sourceIdentity: "source",
        nativeAddress: "https://source.example/work",
        mediaType: "application/json",
        acquiredAt: "2026-07-29T00:00:00.000Z",
        acquisition: {
          requestedAddress: "https://source.example/endpoint",
          method: "GET",
          authorized: false,
        },
        coverage: {
          id: "complete",
          completeness: "complete",
          authority: "official",
        },
        digest: "digest",
        body: "{}",
      },
    ]);

    await expect(
      acceptRecognition(catalogue, {
        execution: acceptedExecution(),
        accepted: accepted(),
      }),
    ).rejects.toThrow("planned catalogue failure");
    const inspection = await catalogue.inspectExecution("execution");
    expect(inspection?.execution.status).toBe("running");
    expect(inspection?.accepted).toBeUndefined();
    expect(inspection?.proposal).toBeUndefined();
  });

  it("enumerates a separately enriched current Source Association without replacing recognition identity", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const initialRecord = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: "{}",
    };
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [initialRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: {
        ...accepted(),
        artifacts: [],
        locations: [],
        blobs: [],
        artifactRevisions: [],
        artifactAssociations: [],
      },
    });

    const enrichmentRecord = {
      ...initialRecord,
      id: "enrichment-record",
      sourceIdentity: "other-source",
      nativeAddress: "other:exact:1",
      coverage: { ...initialRecord.coverage, id: "other.complete" },
    };
    const enrichmentAssociation = {
      id: "other-association",
      subjectId: "asset",
      sourceIdentity: "other-source",
      nativeAddress: "other:exact:1",
    };
    const enrichmentInterpretation = {
      id: "other-interpretation",
      producer: {
        capabilityId: "other.enrichment",
        capabilityVersion: "1",
        contractVersion: "1",
      },
      sourceRecordIds: ["enrichment-record"],
      sourceIdentity: "other-source",
      sourceAddress: "other:exact:1",
      metadata: [
        {
          property: "asset.awards",
          sourceSlot: "other.awards",
          value: "One award",
          sourceRecordIds: ["enrichment-record"],
        },
      ],
      sourceArtifacts: [
        {
          id: "other-poster",
          sourceRecordId: "enrichment-record",
          role: "asset.primary-cover",
          acquisitionReference: "https://other.example/poster.jpg",
          mediaType: "image/jpeg",
        },
      ],
    };
    const checkpointBase = {
      key: "source-enrichment:asset:other",
      subjectId: "asset",
      subject: {
        subjectId: "asset",
        recognitionSourceAssociation: accepted().recognitionSourceAssociation,
        recognitionDecisionId: accepted().recognitionDecision.id,
        sourceAssociations: [accepted().recognitionSourceAssociation],
        metadata: accepted().metadata,
        metadataSourceRecords: [{ id: "record", sourceIdentity: "source" }],
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.awards", necessity: "optional" }],
          artifactRoles: [
            {
              role: "asset.primary-cover",
              necessity: "optional",
              maximum: 1,
            },
          ],
          relationshipTypes: [],
        },
      },
      evidence: {
        kind: "source-association" as const,
        sourceIdentity: "other-source",
        sourceAddress: "other:exact:1",
        explanation: "exact supplementary source",
        producer: {
          capabilityId: "other.candidate",
          capabilityVersion: "1",
          contractVersion: "1",
        },
      },
      fulfilledArtifactRoles: [],
    };
    const candidateEnrichmentExecution: WorkflowExecution = {
      ...execution(),
      id: "enrichment-execution",
      compatibility: {
        workflowVersion: "asset-refresh/2",
        policyVersion: "test",
        capabilityCoordinates: [],
      },
      dispositions: [
        {
          key: checkpointBase.key,
          status: "running",
        },
      ],
      sourceEnrichments: [
        { ...checkpointBase, stage: "candidate-interpreted" },
      ],
    };
    const retainedEnrichmentExecution: WorkflowExecution = {
      ...candidateEnrichmentExecution,
      stage: "source-records-retained",
      sourceRecordIds: ["enrichment-record"],
      sourceEnrichments: [
        {
          ...checkpointBase,
          stage: "source-records-retained",
          sourceRecordIds: ["enrichment-record"],
          collectionFailures: [],
        },
      ],
    };
    await catalogue.createExecution(candidateEnrichmentExecution);
    await catalogue.checkpointSourceEnrichmentRecords({
      expectedExecution: candidateEnrichmentExecution,
      execution: retainedEnrichmentExecution,
      sourceRecords: [enrichmentRecord],
    });
    catalogue.close();
    const recoveredAfterCollection = SqliteCatalogue.forProductData(root);
    await expect(
      recoveredAfterCollection.inspectExecution("enrichment-execution"),
    ).resolves.toMatchObject({
      execution: {
        sourceRecordIds: ["enrichment-record"],
        sourceEnrichments: [
          expect.objectContaining({
            stage: "source-records-retained",
            sourceRecordIds: ["enrichment-record"],
          }),
        ],
      },
      sourceRecords: [expect.objectContaining({ id: "enrichment-record" })],
    });
    const pendingEnrichmentExecution: WorkflowExecution = {
      ...retainedEnrichmentExecution,
      sourceEnrichments: [
        {
          ...checkpointBase,
          stage: "association-interpreted",
          sourceAssociation: enrichmentAssociation,
          interpretation: enrichmentInterpretation,
          sourceRecordIds: ["enrichment-record"],
          sourceArtifacts: [],
        },
      ],
    };
    await recoveredAfterCollection.transitionExecution(
      retainedEnrichmentExecution,
      pendingEnrichmentExecution,
    );
    const appliedEnrichmentExecution: WorkflowExecution = {
      ...pendingEnrichmentExecution,
      sourceEnrichments: [
        {
          ...pendingEnrichmentExecution.sourceEnrichments![0],
          stage: "applied",
        },
      ],
    };
    await recoveredAfterCollection.applySourceEnrichment({
      expectedExecution: pendingEnrichmentExecution,
      execution: appliedEnrichmentExecution,
      expectedRecognitionBaseline: {
        recognitionSourceAssociationId:
          accepted().recognitionSourceAssociation.id,
        recognitionDecisionId: accepted().recognitionDecision.id,
      },
      assetId: "asset",
      sourceAssociation: enrichmentAssociation,
      ...sourceAssociationEstablishment({
        ...enrichmentAssociation,
        sourceRecordIds: [enrichmentRecord.id],
      }),
      sourceRecords: [enrichmentRecord],
      interpretation: enrichmentInterpretation,
      managedArtifacts: {
        artifacts: [{ id: "other-poster-artifact" }],
        locations: [
          {
            id: "other-poster-location",
            artifactId: "other-poster-artifact",
            address: "/managed/other-poster",
            kind: "managed",
          },
        ],
        blobs: [
          {
            digest: "other-poster-digest",
            mediaType: "image/jpeg",
            byteLength: 4,
          },
        ],
        revisions: [
          {
            id: "other-poster-revision",
            artifactId: "other-poster-artifact",
            blobDigest: "other-poster-digest",
          },
        ],
        associations: [
          {
            id: "other-poster-association",
            target: { kind: "entity" as const, entityId: "asset" },
            artifactId: "other-poster-artifact",
            role: "asset.primary-cover",
            sourceRecordIds: ["enrichment-record"],
          },
        ],
      },
    });

    const inspect = async (candidate: SqliteCatalogue) => {
      await expect(
        candidate.inspectExecution("execution"),
      ).resolves.toMatchObject({
        accepted: {
          recognitionSourceAssociation: { id: "association" },
          sourceAssociations: [
            { id: "association", sourceIdentity: "source" },
            { id: "other-association", sourceIdentity: "other-source" },
          ],
          metadata: expect.arrayContaining([
            expect.objectContaining({ property: "asset.title", value: "Work" }),
            expect.objectContaining({
              property: "asset.awards",
              value: "One award",
            }),
          ]),
          artifactAssociations: [
            expect.objectContaining({
              id: "other-poster-association",
              role: "asset.primary-cover",
              sourceRecordIds: ["enrichment-record"],
            }),
          ],
        },
      });
      await expect(
        candidate.inspectExecution("enrichment-execution"),
      ).resolves.toMatchObject({
        execution: {
          sourceRecordIds: ["enrichment-record"],
          sourceEnrichments: [
            expect.objectContaining({
              stage: "applied",
              sourceRecordIds: ["enrichment-record"],
            }),
          ],
        },
      });
    };
    await inspect(recoveredAfterCollection);
    recoveredAfterCollection.close();
    const reopened = SqliteCatalogue.forProductData(root);
    await inspect(reopened);
    reopened.close();
  });

  it("persists composition-selected Metadata Policy enrollment for an explicit subject across restart", async () => {
    const { root, catalogue } = await createCatalogueWithRoot();
    const initialRecord = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: "{}",
    };
    await catalogue.createExecution(execution());
    await retainSourceRecords(catalogue, "execution", [initialRecord]);
    await acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: accepted(),
    });
    catalogue.close();

    const later = SqliteCatalogue.forProductData(root);
    const [reopened] = await later.findAcceptedForSubjects(["asset"]);

    expect(reopened?.accepted).not.toHaveProperty("metadataPolicyIds");
    expect(reopened?.accepted.metadataSourceRecords).toEqual([
      {
        id: "record",
        sourceIdentity: "source",
        nativeAddress: "https://source.example/work",
      },
    ]);
    later.close();
  });

  it("keeps an accepted identity discoverable and reusable after optional enrichment partially succeeds", async () => {
    const catalogue = await createCatalogue();
    const reusePlan = {
      workItems: [
        {
          key: "recognition",
          domainBaseline: "domain",
          sourceBaseline: "source",
          informationBaseline: "information",
        },
      ],
    };
    const frozenCompatibility = {
      workflowVersion: "asset-refresh/2" as const,
      policyVersion: "policy/1",
      capabilityCoordinates: ["recognizer@1/1"],
    };
    const reusableWorkItem = {
      key: "recognition-boundary",
      relativePaths: ["work.bin"],
      reuseFingerprint: "work-item-fingerprint",
      reuseCompatibility: frozenCompatibility,
      sourceRecordIds: ["record"],
      proposalId: "proposal",
      acceptedAssetId: "asset",
      outcome: "accepted" as const,
    };
    const initialRecord = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: "{}",
    };
    await catalogue.createExecution({
      ...execution(),
      reusePlan,
      compatibility: frozenCompatibility,
      workItems: [reusableWorkItem],
    });
    await retainSourceRecords(catalogue, "execution", [initialRecord]);
    await acceptRecognition(catalogue, {
      execution: {
        ...acceptedExecution(),
        outcome: "partially-succeeded",
        reason: "optional supplement unavailable",
        reusePlan,
        compatibility: frozenCompatibility,
        workItems: [reusableWorkItem],
      },
      accepted: accepted(),
    });

    await expect(
      catalogue.findAcceptedForDirectory("/observed"),
    ).resolves.toMatchObject({
      accepted: { entity: { id: "asset" } },
      execution: { outcome: "partially-succeeded" },
    });
    await expect(
      catalogue.findReusableOrdinaryScan({
        plan: reusePlan,
        availableCompatibility: {
          ...frozenCompatibility,
          capabilityCoordinates: [
            ...frozenCompatibility.capabilityCoordinates,
            "unused.collector@1/1",
          ],
        },
      }),
    ).resolves.toMatchObject({
      id: "execution",
      outcome: "partially-succeeded",
    });
    await expect(
      catalogue.findReusableOrdinaryScan({
        plan: reusePlan,
        availableCompatibility: {
          ...frozenCompatibility,
          capabilityCoordinates: [],
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      catalogue.findReusableWorkItem({
        directory: "/observed",
        relativePaths: reusableWorkItem.relativePaths,
        reuseFingerprint: reusableWorkItem.reuseFingerprint,
        availableCompatibility: {
          ...frozenCompatibility,
          capabilityCoordinates: [
            ...frozenCompatibility.capabilityCoordinates,
            "unused.collector@1/1",
          ],
        },
      }),
    ).resolves.toMatchObject({ execution: { id: "execution" } });
    await expect(
      catalogue.findReusableWorkItem({
        directory: "/observed",
        relativePaths: reusableWorkItem.relativePaths,
        reuseFingerprint: reusableWorkItem.reuseFingerprint,
        availableCompatibility: {
          ...frozenCompatibility,
          capabilityCoordinates: [],
        },
      }),
    ).resolves.toBeUndefined();
    catalogue.close();
  });

  it("does not let a degraded no-change item hide its accepted predecessor's capability upgrades", async () => {
    const catalogue = await createCatalogue();
    const fullCompatibility = {
      workflowVersion: "asset-refresh/2" as const,
      policyVersion: "policy/1",
      capabilityCoordinates: [
        "directory@1/1",
        "collector@1/1",
        "interpreter@1/1",
        "recognizer@1/1",
        "acquirer@1/1",
      ],
    };
    const degradedCompatibility = {
      ...fullCompatibility,
      capabilityCoordinates: ["directory@1/1"],
    };
    const workItem = {
      key: "recognition-boundary",
      relativePaths: ["work.bin"],
      reuseFingerprint: "work-item-fingerprint",
      reuseCompatibility: fullCompatibility,
      sourceRecordIds: ["record"],
      proposalId: "proposal",
      acceptedAssetId: "asset",
      outcome: "accepted" as const,
    };
    const record = {
      id: "record",
      sourceIdentity: "source",
      nativeAddress: "https://source.example/work",
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://source.example/work.json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "complete",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: "{}",
    };
    const initial = {
      ...execution(),
      compatibility: fullCompatibility,
      dispositions: [],
      workItems: [workItem],
    };
    await catalogue.createExecution(initial);
    await retainSourceRecords(catalogue, initial.id, [record]);
    await acceptRecognition(catalogue, {
      execution: {
        ...acceptedExecution(),
        compatibility: fullCompatibility,
        dispositions: [],
        workItems: [workItem],
      },
      accepted: accepted(),
    });
    const degraded = {
      ...execution(),
      id: "degraded-no-change",
      compatibility: degradedCompatibility,
      dispositions: [],
      workItems: [
        {
          ...workItem,
          reuseCompatibility: degradedCompatibility,
          outcome: "no-change" as const,
        },
      ],
    };
    await catalogue.createExecution(degraded);
    await catalogue.finishExecution(degraded, {
      ...degraded,
      status: "completed",
      stage: "completed",
      outcome: "no-change",
      proposalId: "proposal",
      acceptedAssetId: "asset",
    });

    await expect(
      catalogue.findReusableWorkItem({
        directory: "/observed",
        relativePaths: workItem.relativePaths,
        reuseFingerprint: workItem.reuseFingerprint,
        availableCompatibility: degradedCompatibility,
      }),
    ).resolves.toBeUndefined();
    catalogue.close();
  });
});

/** 持久化端口只能通过 Drizzle 访问 `DatabaseSync`。 */
function rejectDirectDatabaseQueries(): void {
  const prepare = DatabaseSync.prototype.prepare;
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    source: string,
  ) {
    if (!databaseCallOriginatesInDrizzle())
      throw new Error(`raw DatabaseSync query escaped Drizzle: ${source}`);
    return prepare.call(this, source);
  });
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    source: string,
  ) {
    if (!databaseCallOriginatesInDrizzle())
      throw new Error(`raw DatabaseSync query escaped Drizzle: ${source}`);
    return exec.call(this, source);
  });
}

function databaseCallOriginatesInDrizzle(): boolean {
  return (new Error().stack ?? "")
    .split("\n")
    .some((frame) => /[/\\]drizzle-orm[/\\]/u.test(frame));
}
