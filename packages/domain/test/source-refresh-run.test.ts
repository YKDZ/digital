import { describe, expect, test } from "vitest";

import {
  beginSourceRefreshScopeAcquisition,
  cancelSourceRefreshRun,
  completeSourceRefreshChangeSet,
  createSourceRefreshRun,
  failSourceRefreshScope,
  reviewSourceRefreshChangeSet,
  stageSourceRefreshChangeSet,
  type SourceRefreshSelection,
} from "../src/index.ts";

describe("Source Refresh Run", () => {
  test("creates an inspectable run with its initiator, selection, and scoped lineage baselines", () => {
    const selection: SourceRefreshSelection = {
      subjectId: "asset-1",
      sourceAssociationId: "association-1",
      sourceIdentity: "official-source",
      nativeAddress: "opaque:asset-1",
      selectors: [{ kind: "metadata-property", property: "asset.title" }],
    };

    const run = createSourceRefreshRun({
      id: "refresh-run-1",
      initiatedBy: "user-1",
      initiatedAt: "2026-08-01T00:00:00.000Z",
      requestedSelection: selection,
      reviewPolicy: "automatic",
      baselineLineageHeads: [
        {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: "record-1",
        },
        {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "description",
        },
      ],
    });

    expect(run).toMatchObject({
      id: "refresh-run-1",
      initiatedBy: "user-1",
      requestedSelection: selection,
      reviewPolicy: "automatic",
      phase: "planning",
      scopes: [
        {
          coverage: {
            sourceIdentity: "official-source",
            nativeAddress: "opaque:asset-1",
            coverageId: "title",
          },
          baselineSourceRecordId: "record-1",
          state: "planned",
        },
        {
          coverage: {
            sourceIdentity: "official-source",
            nativeAddress: "opaque:asset-1",
            coverageId: "description",
          },
          state: "planned",
        },
      ],
    });
    expect(run.outcome).toBeUndefined();
  });

  test("refuses an unscoped run instead of manufacturing an empty terminal lifecycle", () => {
    expect(() =>
      createSourceRefreshRun({
        id: "empty-refresh-run",
        initiatedBy: "user-1",
        initiatedAt: "2026-08-01T00:00:00.000Z",
        requestedSelection: {
          subjectId: "asset-1",
          sourceAssociationId: "association-1",
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          selectors: [],
        },
        reviewPolicy: "automatic",
        baselineLineageHeads: [],
      }),
    ).toThrow("Source Refresh Run requires at least one coverage baseline");
  });

  test("checkpoints an in-flight scoped acquisition before cancellation", () => {
    const run = createSourceRefreshRun({
      id: "refresh-run-acquiring",
      initiatedBy: "user-1",
      initiatedAt: "2026-08-01T00:00:00.000Z",
      requestedSelection: {
        subjectId: "asset-1",
        sourceAssociationId: "association-1",
        sourceIdentity: "official-source",
        nativeAddress: "opaque:asset-1",
        selectors: [],
      },
      reviewPolicy: "automatic",
      baselineLineageHeads: [
        {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: "record-1",
        },
      ],
    });

    const acquiring = beginSourceRefreshScopeAcquisition(run, {
      sourceIdentity: "official-source",
      nativeAddress: "opaque:asset-1",
      coverageId: "title",
    });

    expect(acquiring).toMatchObject({
      phase: "acquiring",
      scopes: [{ state: "acquiring", acquisitionAttempt: 1 }],
    });
    expect(cancelSourceRefreshRun(acquiring)).toMatchObject({
      phase: "terminal",
      outcome: "cancelled",
      scopes: [
        { state: "terminal", outcome: "cancelled", acquisitionAttempt: 1 },
      ],
    });
  });

  test("automatically applies one complete Change Set through its scope before deriving completion", () => {
    const run = createSourceRefreshRun({
      id: "refresh-run-automatic",
      initiatedBy: "user-1",
      initiatedAt: "2026-08-01T00:00:00.000Z",
      requestedSelection: {
        subjectId: "asset-1",
        sourceAssociationId: "association-1",
        sourceIdentity: "official-source",
        nativeAddress: "opaque:asset-1",
        selectors: [],
      },
      reviewPolicy: "automatic",
      baselineLineageHeads: [
        {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: "record-1",
        },
      ],
    });

    const staged = stageSourceRefreshChangeSet(
      beginSourceRefreshScopeAcquisition(run, {
        sourceIdentity: "official-source",
        nativeAddress: "opaque:asset-1",
        coverageId: "title",
      }),
      {
        id: "change-set-1",
        coverage: {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
        },
        candidateSourceRecordId: "record-2",
        changes: [
          { kind: "superseded", factReference: "metadata:asset.title" },
        ],
      },
    );

    expect(staged).toMatchObject({
      phase: "applying",
      scopes: [
        {
          state: "applying",
          changeSetId: "change-set-1",
          candidateSourceRecordId: "record-2",
        },
      ],
      changeSets: [
        {
          id: "change-set-1",
          disposition: "automatic",
          candidateSourceRecordId: "record-2",
        },
      ],
    });

    const completed = completeSourceRefreshChangeSet(staged, {
      changeSetId: "change-set-1",
      outcome: "applied",
    });

    expect(completed).toMatchObject({
      phase: "terminal",
      outcome: "succeeded",
      scopes: [{ state: "terminal", outcome: "applied" }],
    });
  });

  test("requires whole-Change-Set review before the same scoped append path", () => {
    const run = createSourceRefreshRun({
      id: "refresh-run-review",
      initiatedBy: "user-1",
      initiatedAt: "2026-08-01T00:00:00.000Z",
      requestedSelection: {
        subjectId: "asset-1",
        sourceAssociationId: "association-1",
        sourceIdentity: "official-source",
        nativeAddress: "opaque:asset-1",
        selectors: [],
      },
      reviewPolicy: "review",
      baselineLineageHeads: [
        {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: "record-1",
        },
      ],
    });
    const awaitingReview = stageSourceRefreshChangeSet(
      beginSourceRefreshScopeAcquisition(run, {
        sourceIdentity: "official-source",
        nativeAddress: "opaque:asset-1",
        coverageId: "title",
      }),
      {
        id: "change-set-review",
        coverage: {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
        },
        candidateSourceRecordId: "record-2",
        changes: [
          { kind: "superseded", factReference: "metadata:asset.title" },
        ],
      },
    );

    expect(awaitingReview).toMatchObject({
      phase: "reviewing",
      scopes: [{ state: "awaiting-review" }],
      changeSets: [{ disposition: "pending" }],
    });

    const approved = reviewSourceRefreshChangeSet(awaitingReview, {
      changeSetId: "change-set-review",
      disposition: "approved",
    });

    expect(approved).toMatchObject({
      phase: "applying",
      scopes: [{ state: "applying" }],
      changeSets: [{ disposition: "approved" }],
    });
    expect(
      completeSourceRefreshChangeSet(approved, {
        changeSetId: "change-set-review",
        outcome: "applied",
      }),
    ).toMatchObject({ outcome: "succeeded" });
  });

  test("escalates a complete retraction for review and records a stale approved scope without rewriting history", () => {
    const run = createSourceRefreshRun({
      id: "refresh-run-retraction",
      initiatedBy: "user-1",
      initiatedAt: "2026-08-01T00:00:00.000Z",
      requestedSelection: {
        subjectId: "asset-1",
        sourceAssociationId: "association-1",
        sourceIdentity: "official-source",
        nativeAddress: "opaque:asset-1",
        selectors: [],
      },
      reviewPolicy: "automatic",
      baselineLineageHeads: [
        {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "profile",
          sourceRecordId: "record-1",
        },
      ],
    });
    const awaitingReview = stageSourceRefreshChangeSet(
      beginSourceRefreshScopeAcquisition(run, {
        sourceIdentity: "official-source",
        nativeAddress: "opaque:asset-1",
        coverageId: "profile",
      }),
      {
        id: "change-set-retraction",
        coverage: {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "profile",
        },
        candidateSourceRecordId: "record-2",
        changes: [
          { kind: "retracted", factReference: "metadata-slot:source.summary" },
        ],
      },
    );
    expect(awaitingReview).toMatchObject({
      phase: "reviewing",
      changeSets: [{ requiresReview: true, disposition: "pending" }],
    });

    const approved = reviewSourceRefreshChangeSet(awaitingReview, {
      changeSetId: "change-set-retraction",
      disposition: "approved",
    });
    expect(
      failSourceRefreshScope(approved, {
        coverage: {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "profile",
        },
        outcome: "stale",
        reason: "lineage changed during review",
      }),
    ).toMatchObject({
      phase: "terminal",
      outcome: "failed",
      scopes: [{ outcome: "stale", reason: "lineage changed during review" }],
    });
  });

  test("cancels only uncommitted scopes without rolling back an applied sibling", () => {
    const run = createSourceRefreshRun({
      id: "refresh-run-partial-cancel",
      initiatedBy: "user-1",
      initiatedAt: "2026-08-01T00:00:00.000Z",
      requestedSelection: {
        subjectId: "asset-1",
        sourceAssociationId: "association-1",
        sourceIdentity: "official-source",
        nativeAddress: "opaque:asset-1",
        selectors: [],
      },
      reviewPolicy: "automatic",
      baselineLineageHeads: [
        {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
          sourceRecordId: "record-title-1",
        },
        {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "description",
          sourceRecordId: "record-description-1",
        },
      ],
    });
    const titleStaged = stageSourceRefreshChangeSet(
      beginSourceRefreshScopeAcquisition(run, {
        sourceIdentity: "official-source",
        nativeAddress: "opaque:asset-1",
        coverageId: "title",
      }),
      {
        id: "change-title",
        coverage: {
          sourceIdentity: "official-source",
          nativeAddress: "opaque:asset-1",
          coverageId: "title",
        },
        candidateSourceRecordId: "record-title-2",
        changes: [
          { kind: "superseded", factReference: "metadata:asset.title" },
        ],
      },
    );
    const titleApplied = completeSourceRefreshChangeSet(titleStaged, {
      changeSetId: "change-title",
      outcome: "applied",
    });

    const cancelled = cancelSourceRefreshRun(titleApplied);

    expect(cancelled).toMatchObject({
      phase: "terminal",
      outcome: "partially-succeeded",
      scopes: [
        { coverage: { coverageId: "title" }, outcome: "applied" },
        { coverage: { coverageId: "description" }, outcome: "cancelled" },
      ],
    });

    expect(cancelled).toMatchObject({
      id: "refresh-run-partial-cancel",
      phase: "terminal",
      outcome: "partially-succeeded",
    });
  });
});
