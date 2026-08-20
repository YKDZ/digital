import { rm } from "node:fs/promises";

import type { WorkflowExecution } from "@digital/application";
import type {
  AcceptedRecognition,
  MetadataAssertion,
  SourceInterpretationBatch,
  SourceRecord,
} from "@digital/domain";
import { SqliteCatalogue } from "@digital/sqlite";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import {
  disposePreparedCatalogueTemplate,
  preparedCatalogueRoot,
} from "./prepared-catalogue.ts";

const roots: string[] = [];

const sourceCollectorProducer = {
  capabilityId: "source.collector",
  capabilityVersion: "2",
  contractVersion: "source-record/v2",
  identity: "source.collector",
  implementationVersion: "2",
  kind: "source-collector",
  interpretationContractVersions: ["source-record/v2"],
} as const;

const sourceInterpreterProducer = {
  capabilityId: "source.interpreter",
  capabilityVersion: "3",
  contractVersion: "interpretation/v3",
  identity: "source.interpreter",
  implementationVersion: "3",
  kind: "source-interpreter",
  interpretationContractVersions: ["interpretation/v3"],
} as const;

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
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

describe("Source Refresh Run SQLite authority", () => {
  test("compare-and-appends one automatic Change Set and projects it through its Workflow Execution reference", async () => {
    const root = await preparedCatalogueRoot();
    roots.push(root);
    const catalogue = SqliteCatalogue.forProductData(root);
    const initial = sourceRecord("initial-record", "Work");
    await catalogue.createExecution(execution("initial-execution"));
    await retainSourceRecords(catalogue, "initial-execution", [initial]);
    await acceptRecognition(catalogue, {
      execution: {
        ...execution("initial-execution"),
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        sourceRecordIds: [initial.id],
        proposalId: "initial-proposal",
        acceptedAssetId: "asset-1",
      },
      accepted: accepted(initial),
    });

    await catalogue.createExecution(execution("refresh-execution"));
    const created = await catalogue.createSourceRefreshRun({
      executionId: "refresh-execution",
      run: {
        id: "run-1",
        initiatedBy: "user-1",
        initiatedAt: "2026-08-01T00:00:00.000Z",
        requestedSelection: {
          subjectId: "asset-1",
          sourceAssociationId: "association-1",
          sourceIdentity: "source",
          nativeAddress: "opaque:asset-1",
          selectors: [{ kind: "metadata-property", property: "asset.title" }],
        },
        reviewPolicy: "automatic",
        baselineLineageHeads: [
          {
            sourceIdentity: "source",
            nativeAddress: "opaque:asset-1",
            coverageId: "title",
            sourceRecordId: initial.id,
          },
        ],
      },
    });
    expect(created).toMatchObject({ phase: "planning", changeSets: [] });

    const candidate = sourceRecord("candidate-record", "Updated work");
    await beginAcquisition(catalogue, "run-1", "title");
    await retainSourceRecords(catalogue, "refresh-execution", [candidate]);
    const staged = await catalogue.stageSourceRefreshChangeSet({
      runId: "run-1",
      candidateSourceRecordId: candidate.id,
      interpretation: interpretation(candidate),
    });

    expect(staged).toMatchObject({
      phase: "applying",
      scopes: [{ state: "applying", changeSetId: expect.any(String) }],
      changeSets: [
        {
          candidateSourceRecordId: candidate.id,
          disposition: "automatic",
          changes: [
            { kind: "superseded", factReference: "metadata:asset.title" },
          ],
        },
      ],
    });

    const applied = await catalogue.applySourceRefreshChangeSet({
      runId: "run-1",
      changeSetId: staged.changeSets[0].id,
    });

    expect(applied).toMatchObject({
      phase: "terminal",
      outcome: "succeeded",
      scopes: [{ outcome: "applied" }],
    });
    await expect(catalogue.inspectSourceRefreshRun("run-1")).resolves.toEqual(
      applied,
    );
    await expect(
      catalogue.inspectExecution("refresh-execution"),
    ).resolves.toMatchObject({
      execution: { sourceRefreshRunIds: ["run-1"] },
      sourceRefreshRuns: [{ id: "run-1", outcome: "succeeded" }],
    });
    await expect(
      catalogue.findAcceptedForSubjects(["asset-1"]),
    ).resolves.toMatchObject([
      {
        accepted: {
          metadata: [
            {
              property: "asset.title",
              value: "Updated work",
              producer: sourceInterpreterProducer,
            },
          ],
        },
      },
    ]);
    await expect(
      catalogue.inspectRawSourceRecord("refresh-execution", candidate.id),
    ).resolves.toMatchObject({ producer: sourceCollectorProducer });
  });

  test("rebuilds planning, acquiring, and awaiting-review Run checkpoints after SQLite reopen", async () => {
    const root = await preparedCatalogueRoot();
    roots.push(root);
    const catalogue = SqliteCatalogue.forProductData(root);
    const initial = sourceRecord("checkpoint-initial", "Work");
    await catalogue.createExecution(execution("checkpoint-initial-execution"));
    await retainSourceRecords(catalogue, "checkpoint-initial-execution", [
      initial,
    ]);
    await acceptRecognition(catalogue, {
      execution: {
        ...execution("checkpoint-initial-execution"),
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        sourceRecordIds: [initial.id],
        proposalId: "initial-proposal",
        acceptedAssetId: "asset-1",
      },
      accepted: accepted(initial),
    });

    await catalogue.createExecution(execution("checkpoint-planning-execution"));
    await catalogue.createSourceRefreshRun({
      executionId: "checkpoint-planning-execution",
      run: refreshRun("checkpoint-planning-run", "automatic", [
        {
          sourceIdentity: "source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: initial.id,
        },
      ]),
    });

    await catalogue.createExecution(
      execution("checkpoint-acquiring-execution"),
    );
    await catalogue.createSourceRefreshRun({
      executionId: "checkpoint-acquiring-execution",
      run: refreshRun("checkpoint-acquiring-run", "automatic", [
        {
          sourceIdentity: "source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: initial.id,
        },
      ]),
    });
    await catalogue.beginSourceRefreshScopeAcquisition({
      runId: "checkpoint-acquiring-run",
      coverage: {
        sourceIdentity: "source",
        nativeAddress: "opaque:asset-1",
        coverageId: "title",
      },
    });

    await catalogue.createExecution(execution("checkpoint-review-execution"));
    await catalogue.createSourceRefreshRun({
      executionId: "checkpoint-review-execution",
      run: refreshRun("checkpoint-review-run", "review", [
        {
          sourceIdentity: "source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: initial.id,
        },
      ]),
    });
    await catalogue.beginSourceRefreshScopeAcquisition({
      runId: "checkpoint-review-run",
      coverage: {
        sourceIdentity: "source",
        nativeAddress: "opaque:asset-1",
        coverageId: "title",
      },
    });
    const candidate = sourceRecord("checkpoint-review-candidate", "Updated");
    await retainSourceRecords(catalogue, "checkpoint-review-execution", [
      candidate,
    ]);
    await catalogue.stageSourceRefreshChangeSet({
      runId: "checkpoint-review-run",
      candidateSourceRecordId: candidate.id,
      interpretation: interpretation(candidate),
    });
    catalogue.close();

    const reopened = SqliteCatalogue.forProductData(root);
    await expect(
      reopened.inspectSourceRefreshRun("checkpoint-planning-run"),
    ).resolves.toMatchObject({
      phase: "planning",
      scopes: [{ state: "planned", acquisitionAttempt: 0 }],
    });
    await expect(
      reopened.inspectSourceRefreshRun("checkpoint-acquiring-run"),
    ).resolves.toMatchObject({
      phase: "acquiring",
      scopes: [{ state: "acquiring", acquisitionAttempt: 1 }],
    });
    await expect(
      reopened.inspectSourceRefreshRun("checkpoint-review-run"),
    ).resolves.toMatchObject({
      phase: "reviewing",
      scopes: [{ state: "awaiting-review", acquisitionAttempt: 1 }],
    });
    reopened.close();
  });

  test("holds complete-coverage retractions for review, then applies them through the same scoped append", async () => {
    const root = await preparedCatalogueRoot();
    roots.push(root);
    const catalogue = SqliteCatalogue.forProductData(root);
    const initial = sourceRecord("initial-profile", "Work", {
      coverageId: "profile",
    });
    const initialInterpretation = interpretation(initial, [
      metadata(initial, "asset.title", "Work"),
      metadata(initial, "asset.description", "Original description"),
    ]);
    await catalogue.createExecution(execution("initial-execution"));
    await retainSourceRecords(catalogue, "initial-execution", [initial]);
    await acceptRecognition(catalogue, {
      execution: {
        ...execution("initial-execution"),
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        sourceRecordIds: [initial.id],
        proposalId: "initial-proposal",
        acceptedAssetId: "asset-1",
      },
      accepted: accepted(initial, initialInterpretation),
    });

    await catalogue.createExecution(execution("refresh-execution"));
    await catalogue.createSourceRefreshRun({
      executionId: "refresh-execution",
      run: refreshRun("retraction-run", "automatic", [
        {
          sourceIdentity: "source",
          nativeAddress: "opaque:asset-1",
          coverageId: "profile",
          sourceRecordId: initial.id,
        },
      ]),
    });
    await beginAcquisition(catalogue, "retraction-run", "profile");
    const emptyProfile = sourceRecord("empty-profile", "ignored", {
      coverageId: "profile",
      completeness: "complete",
    });
    await retainSourceRecords(catalogue, "refresh-execution", [emptyProfile]);

    const awaitingReview = await catalogue.stageSourceRefreshChangeSet({
      runId: "retraction-run",
      candidateSourceRecordId: emptyProfile.id,
      interpretation: interpretation(emptyProfile, []),
    });

    expect(awaitingReview).toMatchObject({
      phase: "reviewing",
      scopes: [{ state: "awaiting-review" }],
      changeSets: [
        {
          requiresReview: true,
          disposition: "pending",
          changes: [
            { kind: "retracted", factReference: "metadata-slot:source.title" },
            {
              kind: "retracted",
              factReference: "metadata-slot:source.description",
            },
          ],
        },
      ],
    });

    const approved = await catalogue.reviewSourceRefreshChangeSet({
      runId: "retraction-run",
      changeSetId: awaitingReview.changeSets[0].id,
      disposition: "approved",
    });
    expect(approved.phase).toBe("applying");
    await expect(
      catalogue.applySourceRefreshChangeSet({
        runId: "retraction-run",
        changeSetId: awaitingReview.changeSets[0].id,
      }),
    ).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(
      catalogue.findAcceptedForSubjects(["asset-1"]),
    ).resolves.toEqual([
      expect.objectContaining({
        accepted: expect.objectContaining({ metadata: [] }),
      }),
    ]);
  });

  test("marks an approved Change Set stale rather than overwriting a newer scoped append", async () => {
    const root = await preparedCatalogueRoot();
    roots.push(root);
    const catalogue = SqliteCatalogue.forProductData(root);
    const initial = sourceRecord("initial-record", "Work");
    await catalogue.createExecution(execution("initial-execution"));
    await retainSourceRecords(catalogue, "initial-execution", [initial]);
    await acceptRecognition(catalogue, {
      execution: {
        ...execution("initial-execution"),
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        sourceRecordIds: [initial.id],
        proposalId: "initial-proposal",
        acceptedAssetId: "asset-1",
      },
      accepted: accepted(initial),
    });

    await catalogue.createExecution(execution("review-execution"));
    await catalogue.createSourceRefreshRun({
      executionId: "review-execution",
      run: refreshRun("review-run", "review", [
        {
          sourceIdentity: "source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: initial.id,
        },
      ]),
    });
    await beginAcquisition(catalogue, "review-run", "title");
    const reviewedCandidate = sourceRecord(
      "reviewed-candidate",
      "Reviewed work",
    );
    await retainSourceRecords(catalogue, "review-execution", [
      reviewedCandidate,
    ]);
    const awaitingReview = await catalogue.stageSourceRefreshChangeSet({
      runId: "review-run",
      candidateSourceRecordId: reviewedCandidate.id,
      interpretation: interpretation(reviewedCandidate),
    });

    await catalogue.createExecution(execution("newer-execution"));
    await catalogue.createSourceRefreshRun({
      executionId: "newer-execution",
      run: refreshRun("newer-run", "automatic", [
        {
          sourceIdentity: "source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: initial.id,
        },
      ]),
    });
    await beginAcquisition(catalogue, "newer-run", "title");
    const newerCandidate = sourceRecord("newer-candidate", "Newer work");
    await retainSourceRecords(catalogue, "newer-execution", [newerCandidate]);
    const newer = await catalogue.stageSourceRefreshChangeSet({
      runId: "newer-run",
      candidateSourceRecordId: newerCandidate.id,
      interpretation: interpretation(newerCandidate),
    });
    await catalogue.applySourceRefreshChangeSet({
      runId: "newer-run",
      changeSetId: newer.changeSets[0].id,
    });

    const approved = await catalogue.reviewSourceRefreshChangeSet({
      runId: "review-run",
      changeSetId: awaitingReview.changeSets[0].id,
      disposition: "approved",
    });
    expect(approved.phase).toBe("applying");
    await expect(
      catalogue.applySourceRefreshChangeSet({
        runId: "review-run",
        changeSetId: awaitingReview.changeSets[0].id,
      }),
    ).resolves.toMatchObject({
      phase: "terminal",
      outcome: "failed",
      scopes: [
        {
          state: "terminal",
          outcome: "stale",
          reason: expect.stringContaining("stale"),
        },
      ],
    });
    await expect(
      catalogue.findAcceptedForSubjects(["asset-1"]),
    ).resolves.toMatchObject([
      {
        accepted: {
          metadata: [{ property: "asset.title", value: "Newer work" }],
        },
      },
    ]);
  });

  test("cancels only an uncommitted sibling and creates a new Run for its retry", async () => {
    const root = await preparedCatalogueRoot();
    roots.push(root);
    const catalogue = SqliteCatalogue.forProductData(root);
    const initial = sourceRecord("initial-title", "Work");
    await catalogue.createExecution(execution("initial-execution"));
    await retainSourceRecords(catalogue, "initial-execution", [initial]);
    await acceptRecognition(catalogue, {
      execution: {
        ...execution("initial-execution"),
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        sourceRecordIds: [initial.id],
        proposalId: "initial-proposal",
        acceptedAssetId: "asset-1",
      },
      accepted: accepted(initial),
    });

    await catalogue.createExecution(execution("refresh-execution"));
    await catalogue.createSourceRefreshRun({
      executionId: "refresh-execution",
      run: refreshRun("partial-run", "automatic", [
        {
          sourceIdentity: "source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: initial.id,
        },
        {
          sourceIdentity: "source",
          nativeAddress: "opaque:asset-1",
          coverageId: "description",
        },
      ]),
    });
    await beginAcquisition(catalogue, "partial-run", "title");
    const updatedTitle = sourceRecord("updated-title", "Updated work");
    await retainSourceRecords(catalogue, "refresh-execution", [updatedTitle]);
    const staged = await catalogue.stageSourceRefreshChangeSet({
      runId: "partial-run",
      candidateSourceRecordId: updatedTitle.id,
      interpretation: interpretation(updatedTitle),
    });
    await catalogue.applySourceRefreshChangeSet({
      runId: "partial-run",
      changeSetId: staged.changeSets[0].id,
    });

    await expect(
      catalogue.cancelSourceRefreshRun("partial-run"),
    ).resolves.toMatchObject({
      phase: "terminal",
      outcome: "partially-succeeded",
      scopes: [
        { coverage: { coverageId: "title" }, outcome: "applied" },
        { coverage: { coverageId: "description" }, outcome: "cancelled" },
      ],
    });
    await expect(
      catalogue.findAcceptedForSubjects(["asset-1"]),
    ).resolves.toMatchObject([
      {
        accepted: {
          metadata: [{ property: "asset.title", value: "Updated work" }],
        },
      },
    ]);

    await expect(
      catalogue.inspectSourceRefreshRun("partial-run"),
    ).resolves.toMatchObject({
      phase: "terminal",
      outcome: "partially-succeeded",
    });
  });
});

function execution(id: string): WorkflowExecution {
  return {
    id,
    selection: { intent: "metadata-refresh" },
    status: "running",
    stage: "recognition",
    sourceRecordIds: [],
    compatibility: {
      workflowVersion: "asset-refresh/2",
      policyVersion: "test",
      capabilityCoordinates: [],
    },
    dispositions: [],
  };
}

function sourceRecord(
  id: string,
  title: string,
  options: {
    readonly coverageId?: string;
    readonly completeness?: "complete" | "partial";
  } = {},
): SourceRecord {
  return {
    id,
    sourceIdentity: "source",
    nativeAddress: "opaque:asset-1",
    mediaType: "application/json",
    acquiredAt: "2026-08-01T00:00:00.000Z",
    acquisition: {
      requestedAddress: "https://source.example/asset-1",
      method: "GET",
      authorized: true,
    },
    coverage: {
      id: options.coverageId ?? "title",
      completeness: options.completeness ?? "complete",
      authority: "official",
    },
    digest: `digest:${title}`,
    body: JSON.stringify({ title }),
    producer: sourceCollectorProducer,
  };
}

function interpretation(
  record: SourceRecord,
  assertions: readonly MetadataAssertion[] = [
    metadata(record, "asset.title", JSON.parse(record.body).title as string),
  ],
): SourceInterpretationBatch {
  return {
    id: `interpretation:${record.id}`,
    producer: sourceInterpreterProducer,
    sourceRecordIds: [record.id],
    sourceIdentity: record.sourceIdentity,
    sourceAddress: record.nativeAddress,
    metadata: assertions,
    sourceArtifacts: [],
  };
}

function metadata(
  record: SourceRecord,
  property: string,
  value: string,
): MetadataAssertion {
  return {
    property,
    sourceSlot: `source.${property.slice("asset.".length)}`,
    value,
    sourceRecordIds: [record.id],
    producer: sourceInterpreterProducer,
  };
}

function refreshRun(
  id: string,
  reviewPolicy: "automatic" | "review",
  baselineLineageHeads: readonly {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
    readonly coverageId: string;
    readonly sourceRecordId?: string;
  }[],
) {
  return {
    id,
    initiatedBy: "user-1",
    initiatedAt: "2026-08-01T00:00:00.000Z",
    requestedSelection: {
      subjectId: "asset-1",
      sourceAssociationId: "association-1",
      sourceIdentity: "source",
      nativeAddress: "opaque:asset-1",
      selectors: [],
    },
    reviewPolicy,
    baselineLineageHeads,
  } as const;
}

async function beginAcquisition(
  catalogue: SqliteCatalogue,
  runId: string,
  coverageId: string,
): Promise<void> {
  await catalogue.beginSourceRefreshScopeAcquisition({
    runId,
    coverage: {
      sourceIdentity: "source",
      nativeAddress: "opaque:asset-1",
      coverageId,
    },
  });
}

function accepted(
  record: SourceRecord,
  sourceInterpretation = interpretation(record),
): AcceptedRecognition {
  const proposal = {
    id: "initial-proposal",
    interpretation: sourceInterpretation,
    ruleResults: [
      {
        capabilityId: "recognizer",
        capabilityVersion: "1",
        ruleId: "exact",
        ruleVersion: "1",
        outcome: "satisfied" as const,
        explanation: "exact address",
        evidence: [],
      },
    ],
  };
  return {
    proposal,
    entity: { id: "asset-1", kind: "digital-asset" },
    sourceAssociation: {
      id: "association-1",
      subjectId: "asset-1",
      sourceIdentity: "source",
      nativeAddress: "opaque:asset-1",
      proposalId: proposal.id,
    },
    recognitionDecision: {
      id: "decision-1",
      proposalId: proposal.id,
      assetId: "asset-1",
      acceptedRuleResults: proposal.ruleResults,
    },
    artifacts: [],
    locations: [],
    blobs: [],
    artifactRevisions: [],
    artifactAssociations: [],
    metadata: proposal.interpretation.metadata,
  };
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
