import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, constants as sqliteConstants } from "node:sqlite";

import {
  AssetRefreshAutomation,
  AssetRefreshWorkflow,
  attachAssetRefreshAutomation,
  sha256,
  ObservedRootRegistrations,
  type ChangeImpactPreview,
  type ObservedRootRegistration,
  type SourceEnrichmentCheckpoint,
  type WorkflowExecution,
} from "@digital/application";
import { DlsiteExactDirectoryInterpreter } from "@digital/dlsite";
import type {
  AcceptedRecognition,
  SourceInterpretationBatch,
  SourceRecord,
} from "@digital/domain";
import { OmdbCollector, OmdbSourceInterpreter } from "@digital/omdb";
import { SqliteCatalogue } from "@digital/sqlite";
import {
  InMemoryObservedFilesystemCapability,
  InMemoryObservedRootCleanupReporter,
  InMemoryObservedRootRegistrationStore,
  type InMemoryObservedFilesystemOptions,
} from "@digital/test-support";
import {
  TmdbCollector,
  TmdbSourceInterpreter,
  TmdbStrictFilmRecognizer,
} from "@digital/tmdb";
import { afterAll, afterEach, expect, it, vi } from "vitest";

import { composeAssetRefresh } from "../src/runtime.ts";
import {
  disposePreparedCatalogueTemplate,
  preparedCatalogueRoot,
} from "./prepared-catalogue.ts";

const cleanup: string[] = [];

function instrumentedObservedRootRegistration(
  id: string,
  logicalDirectory = `/observed/${id}`,
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

function instrumentedObservedRootRegistrations(
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
  const store =
    new InMemoryObservedRootRegistrationStore<ObservedRootRegistration>(
      [
        ["manual", "/observed/manual"],
        ["automatic", "/observed/automatic"],
        ["RJ01668691", "/observed/RJ01668691"],
        ["same-title-a", "/observed/same-title-a"],
        ["same-title-b", "/observed/same-title-b"],
      ].map(([id, logicalDirectory]) =>
        instrumentedObservedRootRegistration(id, logicalDirectory),
      ),
    );
  const cleanupReporter = new InMemoryObservedRootCleanupReporter();
  return new ObservedRootRegistrations({
    commands: store.commands,
    queries: store.queries,
    filesystem: new InMemoryObservedFilesystemCapability(filesystemOptions),
    productDataDirectory: "/product-data",
    managedArtifactDirectory: "/product-data/managed-artifacts",
    cleanupFailureReporter: cleanupReporter,
    cleanupFailureFallback: cleanupReporter,
  });
}

function instrumentedRegistrationId(directory: string): string {
  const registrationId = new Map<string, string>([
    ["/observed/manual", "manual"],
    ["/observed/RJ01668691", "RJ01668691"],
    ["/observed/same-title-a", "same-title-a"],
    ["/observed/same-title-b", "same-title-b"],
  ]).get(directory);
  if (registrationId === undefined)
    throw new Error(`测试文件位置未登记：${directory}`);
  return registrationId;
}

/** 测试迁移桥接：只调用公开已注册根扫描 API。 */
async function scanInstrumentedObservedScope(
  workflow: Pick<AssetRefreshWorkflow, "scanObservedScope">,
  input: Omit<
    Parameters<AssetRefreshWorkflow["scanObservedScope"]>[0],
    "registrationId" | "relativeScope"
  > & { readonly directory: string },
) {
  const { directory, ...request } = input;
  return await workflow.scanObservedScope({
    registrationId: instrumentedRegistrationId(directory),
    relativeScope: ".",
    ...request,
  });
}

async function declaredPackageExports(
  declarationUrl: URL,
  visited = new Set<string>(),
): Promise<Set<string>> {
  if (visited.has(declarationUrl.href)) return new Set();
  visited.add(declarationUrl.href);
  const declaration = await readFile(declarationUrl, "utf8");
  const exported = new Set(
    [
      ...declaration.matchAll(
        /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|type|interface|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gmu,
      ),
    ].map((match) => match[1]!),
  );
  for (const match of declaration.matchAll(
    /^export(?:\s+type)?\s*\{([^}]*)\}(?:\s+from\s+"[^"]+")?;/gmu,
  )) {
    for (const specifier of match[1]!.split(",")) {
      const [name, alias] = specifier
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u);
      if (name !== "") exported.add(alias ?? name!);
    }
  }
  for (const match of declaration.matchAll(
    /^export\s+\*\s+from\s+"([^"]+)";/gmu,
  )) {
    const target = new URL(
      match[1]!.replace(/\.js$/u, ".d.ts"),
      declarationUrl,
    );
    for (const name of await declaredPackageExports(target, visited)) {
      exported.add(name);
    }
  }
  return exported;
}

afterEach(async () => {
  vi.restoreAllMocks();
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

it("commits one validated recognition adoption without direct DatabaseSync queries", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);

  // 启用守卫前打开显式准备的 WAL 目录：本测试验证识别路径，而非数据库模式准备。
  await catalogue.listExecutions();
  await catalogue.createExecution(runningExecution());
  await retainSourceRecords(catalogue, "dlsite-execution", [sourceRecord()]);

  rejectDirectDatabaseQueries();

  await expect(
    acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: acceptedRecognition(),
    }),
  ).resolves.toBeUndefined();

  catalogue.close();
});

it("reopens and enumerates an observed-evidence recognition without a source association", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const producer = {
    capabilityId: "epub-inspector",
    capabilityVersion: "1",
    contractVersion: "epub/3",
  };
  const revision = {
    observedArtifactReference: "book.epub",
    blob: {
      digest: "epub-digest",
      mediaType: "application/epub+zip",
      byteLength: 1,
    },
    producer,
  };
  const evidence = {
    kind: "format.valid-publication",
    explanation: "一个有效且边界完整的出版物修订版",
    producer,
    inspection: {
      identifiers: [],
      observedArtifactReference: revision.observedArtifactReference,
      revision: revision.blob,
      metadata: [],
      parts: [],
    },
  };
  const proposal = {
    id: "local-proposal",
    basis: {
      kind: "observed-evidence" as const,
      producer,
      evidence: [evidence],
      artifactRevisions: [revision],
    },
    ruleResults: [
      {
        capabilityId: "local-recognizer",
        capabilityVersion: "1",
        ruleId: "valid-single-revision",
        ruleVersion: "1",
        outcome: "satisfied" as const,
        explanation: "精确观察证据建立一个本地资产边界",
        evidence: [evidence],
      },
    ],
  };
  const accepted: AcceptedRecognition = {
    proposal,
    entity: { id: "local-asset", kind: "digital-asset" },
    sourceAssociations: [],
    recognitionDecision: {
      id: "local-decision",
      proposalId: proposal.id,
      assetId: "local-asset",
      acceptedRuleResults: proposal.ruleResults,
    },
    artifacts: [],
    locations: [],
    blobs: [],
    artifactRevisions: [],
    artifactAssociations: [],
    metadata: [],
    entities: [],
    relationships: [],
  };
  const reusePlan = {
    workItems: [
      {
        key: "local-book",
        domainBaseline: "local-domain",
        sourceBaseline: "no-source",
        informationBaseline: "local-information",
      },
    ],
  };
  const compatibility = {
    workflowVersion: "asset-refresh/2" as const,
    policyVersion: "local-policy/1",
    capabilityCoordinates: ["epub-inspector@1/epub/3"],
  };
  const running = {
    ...runningExecution(),
    id: "local-execution",
    reusePlan,
    compatibility,
  };
  await catalogue.createExecution(running);
  await acceptRecognition(catalogue, {
    execution: {
      ...running,
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      proposalId: proposal.id,
      acceptedAssetId: accepted.entity.id,
    },
    accepted,
  });
  catalogue.close();

  const reopened = SqliteCatalogue.forProductData(root);
  await expect(reopened.inspectExecution(running.id)).resolves.toMatchObject({
    accepted: {
      entity: { id: "local-asset" },
      proposal: { basis: { kind: "observed-evidence" } },
      sourceAssociations: [],
    },
  });
  await expect(
    reopened.listCurrentCataloguePage({ limit: 10 }),
  ).resolves.toMatchObject({ items: [{ entity: { id: "local-asset" } }] });
  await expect(
    reopened.findReusableOrdinaryScan({
      plan: reusePlan,
      availableCompatibility: compatibility,
    }),
  ).resolves.toMatchObject({ id: running.id });
  const current = (await reopened.inspectExecution(running.id))!.accepted!;
  expect(current.recognitionSourceAssociation).toBeUndefined();
  expect(current.recognitionDecision.id).toBe("local-decision");
  const nextRevision = {
    ...revision,
    blob: { ...revision.blob, digest: "epub-digest-2", byteLength: 2 },
  };
  const nextEvidence = {
    ...evidence,
    inspection: {
      ...evidence.inspection,
      revision: nextRevision.blob,
    },
  };
  const nextProposal = {
    ...proposal,
    id: "local-proposal-2",
    basis: {
      ...proposal.basis,
      evidence: [nextEvidence],
      artifactRevisions: [nextRevision],
    },
    ruleResults: proposal.ruleResults.map((result) => ({
      ...result,
      evidence: [nextEvidence],
    })),
  };
  const reevaluation = { ...runningExecution(), id: "local-reevaluation" };
  await reopened.createExecution(reevaluation);
  const nextAccepted: AcceptedRecognition = {
    ...current,
    proposal: nextProposal,
    artifacts: [{ id: "local-epub-artifact" }],
    locations: [
      {
        id: "local-epub-location-2",
        artifactId: "local-epub-artifact",
        address: "/observed/book.epub",
        kind: "observed",
      },
    ],
    blobs: [nextRevision.blob],
    artifactRevisions: [
      {
        id: "local-epub-revision-2",
        artifactId: "local-epub-artifact",
        blobDigest: nextRevision.blob.digest,
        producer,
      },
    ],
    artifactAssociations: [],
    metadata: [
      {
        property: "asset.title",
        sourceSlot: "epub.opf.title",
        value: "本地标题第二版",
        sourceRecordIds: [],
        producer,
        observedArtifactPart: {
          artifactId: "local-epub-artifact",
          revisionId: "local-epub-revision-2",
          locator: "epub:opf/dc:title[1]",
        },
      },
    ],
  };
  await expect(
    reopened.refreshAcceptedRecognition({
      expectedExecution: reevaluation,
      execution: {
        ...reevaluation,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        proposalId: nextProposal.id,
        acceptedAssetId: accepted.entity.id,
      },
      current,
      accepted: nextAccepted,
      sourceRecords: [],
      expectedLineageHeads: [],
    }),
  ).resolves.toBeUndefined();
  await expect(
    reopened.inspectExecution(reevaluation.id),
  ).resolves.toMatchObject({
    proposal: { id: nextProposal.id, basis: { kind: "observed-evidence" } },
    accepted: {
      entity: { id: accepted.entity.id },
      recognitionDecision: { id: accepted.recognitionDecision.id },
      sourceAssociations: [],
      artifactRevisions: [
        { id: "local-epub-revision-2", blobDigest: "epub-digest-2" },
      ],
      metadata: [{ value: "本地标题第二版" }],
    },
  });
  const currentAfterReevaluation = (await reopened.inspectExecution(
    reevaluation.id,
  ))!.accepted!;
  const failedExecution = {
    ...runningExecution(),
    id: "local-failed-reevaluation",
  };
  await reopened.createExecution(failedExecution);
  const failedProposal = { ...nextProposal, id: "local-failed-proposal" };
  await expect(
    reopened.refreshAcceptedRecognition({
      expectedExecution: failedExecution,
      execution: {
        ...failedExecution,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        proposalId: failedProposal.id,
        acceptedAssetId: accepted.entity.id,
      },
      current: currentAfterReevaluation,
      accepted: {
        ...currentAfterReevaluation,
        proposal: failedProposal,
        blobs: [
          ...currentAfterReevaluation.blobs,
          {
            digest: "conflicting-epub-digest",
            mediaType: "application/epub+zip",
            byteLength: 3,
          },
        ],
        artifactRevisions: currentAfterReevaluation.artifactRevisions.map(
          (item) => ({
            ...item,
            blobDigest: "conflicting-epub-digest",
          }),
        ),
      },
      sourceRecords: [],
      expectedLineageHeads: [],
    }),
  ).rejects.toThrow("Artifact Revision local-epub-revision-2 conflicts");
  const rolledBack = await reopened.inspectExecution(failedExecution.id);
  expect(rolledBack?.execution).toMatchObject({ status: "running" });
  expect(rolledBack?.proposal).toBeUndefined();
  const retryProposal = { ...nextProposal, id: "local-retry-proposal" };
  await expect(
    reopened.refreshAcceptedRecognition({
      expectedExecution: failedExecution,
      execution: {
        ...failedExecution,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        proposalId: retryProposal.id,
        acceptedAssetId: accepted.entity.id,
      },
      current: currentAfterReevaluation,
      accepted: { ...currentAfterReevaluation, proposal: retryProposal },
      sourceRecords: [],
      expectedLineageHeads: [],
    }),
  ).resolves.toBeUndefined();
  reopened.close();

  const replacement = SqliteCatalogue.forProductData(root);
  const replacementExecution = {
    ...runningExecution(),
    id: "local-identity-replacement",
  };
  await replacement.createExecution(replacementExecution);
  const replacementProposal = {
    ...nextProposal,
    id: "local-proposal-3",
  };
  const currentProjection = {
    sourceAssociations: [],
    metadata: nextAccepted.metadata,
    entities: nextAccepted.entities ?? [],
    entityMentions: nextAccepted.entityMentions ?? [],
    entityResolutionDecisions: nextAccepted.entityResolutionDecisions ?? [],
    relationships: nextAccepted.relationships ?? [],
    artifacts: nextAccepted.artifacts,
    locations: nextAccepted.locations,
    blobs: nextAccepted.blobs,
    artifactRevisions: nextAccepted.artifactRevisions,
    artifactAssociations: nextAccepted.artifactAssociations,
  };
  const completeBaseline = await replacement.freezeChangeImpactBaseline({
    assetId: accepted.entity.id,
    recognitionDecisionId: accepted.recognitionDecision.id,
  });
  const preview = {
    id: "local-change-impact",
    executionId: replacementExecution.id,
    assetId: accepted.entity.id,
    proposal: replacementProposal,
    baselines: [
      {
        key: "recognition-decision",
        value: accepted.recognitionDecision.id,
      },
      { key: "source-records", value: "" },
      { key: "complete-current-projection", value: completeBaseline },
    ],
    current: currentProjection,
    projected: currentProjection,
    blockingConditions: [],
    status: "awaiting-confirmation" as const,
  };
  await replacement.finishExecutionWithChangeImpactPreview({
    expectedExecution: replacementExecution,
    execution: {
      ...replacementExecution,
      status: "completed",
      stage: "completed",
      outcome: "proposal",
      proposalId: replacementProposal.id,
    },
    proposal: replacementProposal,
    preview,
  });
  replacement.close();

  const afterPreviewRestart = SqliteCatalogue.forProductData(root);
  const successorDecision = {
    id: "local-decision-3",
    proposalId: replacementProposal.id,
    assetId: accepted.entity.id,
    acceptedRuleResults: replacementProposal.ruleResults,
  };
  await expect(
    afterPreviewRestart.applyChangeImpactPreview({
      preview,
      plan: {
        successorDecision,
        supersession: {
          id: "local-decision-supersession-3",
          predecessorDecisionId: accepted.recognitionDecision.id,
          successorDecisionId: successorDecision.id,
        },
      },
    }),
  ).resolves.toBe("applied");
  await expect(
    afterPreviewRestart.findAcceptedForSubjects([accepted.entity.id]),
  ).resolves.toMatchObject([
    {
      accepted: {
        proposal: { id: replacementProposal.id },
        recognitionDecision: { id: successorDecision.id },
        sourceAssociations: [],
      },
    },
  ]);
  await expect(
    afterPreviewRestart.findReusableOrdinaryScan({
      plan: reusePlan,
      availableCompatibility: compatibility,
    }),
  ).resolves.toBeUndefined();
  afterPreviewRestart.close();
});

it("accepts an equivalent sparse Workflow Execution baseline after durable default normalization", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const sparseExpected = runningExecution();

  await catalogue.createExecution(sparseExpected);
  await retainSourceRecords(catalogue, sparseExpected.id, [sourceRecord()]);

  await expect(
    catalogue.acceptRecognition({
      expectedExecution: sparseExpected,
      execution: acceptedExecution(),
      accepted: acceptedRecognition(),
    }),
  ).resolves.toBeUndefined();

  await expect(
    catalogue.inspectExecution(sparseExpected.id),
  ).resolves.toMatchObject({
    execution: {
      status: "completed",
      stage: "completed",
      outcome: "accepted",
    },
    accepted: { entity: { id: "dlsite-work" } },
  });
  catalogue.close();
});

it("hydrates one accepted inspection graph without direct DatabaseSync queries", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const running = runningExecution();
  const completed = acceptedExecution();

  await catalogue.listExecutions();
  await catalogue.createExecution(running);
  await retainSourceRecords(catalogue, running.id, [sourceRecord()]);
  await acceptRecognition(catalogue, {
    execution: completed,
    accepted: acceptedRecognition(),
  });

  rejectDirectDatabaseQueries();
  await expect(catalogue.inspectExecution(completed.id)).resolves.toMatchObject(
    {
      execution: expect.objectContaining({
        id: completed.id,
        outcome: "accepted",
      }),
      proposal: expect.objectContaining({ id: completed.proposalId }),
      accepted: expect.objectContaining({
        entity: { id: "dlsite-work", kind: "digital-asset" },
        recognitionSourceAssociation: expect.objectContaining({
          id: "dlsite-association",
        }),
      }),
    },
  );
  catalogue.close();
});

it("uses only Drizzle queries while a real OMDb source result advances one persisted Source Refresh scope", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const initial = await omdbSourceResult({
    awards: "Nominated for 1 Oscar.",
  });

  // 启用路径守卫前引导已经采用的身份。测试从持久来源刷新运行边界开始。
  await catalogue.createExecution(omdbExecution("omdb-initial-execution"));
  await retainSourceRecords(catalogue, "omdb-initial-execution", [
    initial.record,
  ]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("omdb-initial-execution"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [initial.record.id],
      proposalId: "omdb-initial-proposal",
      acceptedAssetId: "omdb-film",
    },
    accepted: omdbAcceptedRecognition(initial),
  });
  await catalogue.createExecution(omdbExecution("omdb-refresh-execution"));

  const candidate = await omdbSourceResult({ awards: "Won 1 Oscar." });
  rejectDirectDatabaseQueries();

  const run = await catalogue.createSourceRefreshRun({
    executionId: "omdb-refresh-execution",
    run: {
      id: "omdb-refresh-run",
      initiatedBy: "user-1",
      initiatedAt: "2026-08-02T00:00:00.000Z",
      requestedSelection: {
        subjectId: "omdb-film",
        sourceAssociationId: "omdb-association",
        sourceIdentity: "omdb",
        nativeAddress: "omdb:imdb:tt1234567",
        selectors: [{ kind: "metadata-property", property: "asset.awards" }],
      },
      reviewPolicy: "automatic",
      baselineLineageHeads: [
        {
          sourceIdentity: "omdb",
          nativeAddress: "omdb:imdb:tt1234567",
          coverageId: initial.record.coverage.id,
          sourceRecordId: initial.record.id,
        },
      ],
    },
  });
  await catalogue.beginSourceRefreshScopeAcquisition({
    runId: run.id,
    coverage: {
      sourceIdentity: "omdb",
      nativeAddress: "omdb:imdb:tt1234567",
      coverageId: candidate.record.coverage.id,
    },
  });
  await retainSourceRecords(catalogue, "omdb-refresh-execution", [
    candidate.record,
  ]);
  const staged = await catalogue.stageSourceRefreshChangeSet({
    runId: run.id,
    candidateSourceRecordId: candidate.record.id,
    interpretation: candidate.interpretation,
  });

  await expect(
    catalogue.applySourceRefreshChangeSet({
      runId: run.id,
      changeSetId: staged.changeSets[0].id,
    }),
  ).resolves.toMatchObject({
    phase: "terminal",
    outcome: "succeeded",
    scopes: [{ outcome: "applied" }],
  });
  await expect(
    catalogue.findAcceptedForSubjects(["omdb-film"]),
  ).resolves.toEqual([
    expect.objectContaining({
      accepted: expect.objectContaining({
        metadata: expect.arrayContaining([
          expect.objectContaining({
            property: "asset.awards",
            value: "Won 1 Oscar.",
          }),
        ]),
      }),
    }),
  ]);

  catalogue.close();
});

it("uses only Drizzle writes through the public Metadata Refresh persistence port", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const initial = await omdbSourceResult({ awards: "Nominated for 1 Oscar." });
  await catalogue.createExecution(omdbExecution("omdb-public-initial"));
  await retainSourceRecords(catalogue, "omdb-public-initial", [initial.record]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("omdb-public-initial"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [initial.record.id],
      proposalId: "omdb-initial-proposal",
      acceptedAssetId: "omdb-film",
    },
    accepted: omdbAcceptedRecognition(initial),
  });

  const candidate = await omdbSourceResult({ awards: "Won 1 Oscar." });
  await catalogue.createExecution(omdbExecution("omdb-public-refresh"));
  await retainSourceRecords(catalogue, "omdb-public-refresh", [
    candidate.record,
  ]);
  const expected = (await catalogue.inspectExecution("omdb-public-refresh"))!
    .execution;
  const heads = await catalogue.freezeSourceLineageHeads({
    assetId: "omdb-film",
    sourceAssociation: {
      id: "omdb-association",
      subjectId: "omdb-film",
      sourceIdentity: "omdb",
      nativeAddress: "omdb:imdb:tt1234567",
      proposalId: "omdb-initial-proposal",
    },
    coverageIds: [candidate.record.coverage.id],
  });

  rejectDirectDatabaseWrites();
  await expect(
    catalogue.applyMetadataRefresh({
      expectedExecution: expected,
      execution: expected,
      submission: {
        assetId: "omdb-film",
        sourceAssociation: {
          id: "omdb-association",
          subjectId: "omdb-film",
          sourceIdentity: "omdb",
          nativeAddress: "omdb:imdb:tt1234567",
          proposalId: "omdb-initial-proposal",
        },
        sourceRecords: [candidate.record],
        interpretation: candidate.interpretation,
        expectedLineageHeads: heads,
      },
    }),
  ).resolves.toBeUndefined();
  await expect(
    catalogue.findAcceptedForSubjects(["omdb-film"]),
  ).resolves.toEqual([
    expect.objectContaining({
      accepted: expect.objectContaining({
        metadata: expect.arrayContaining([
          expect.objectContaining({
            property: "asset.awards",
            value: "Won 1 Oscar.",
            sourceRecordIds: [candidate.record.id],
          }),
        ]),
      }),
    }),
  ]);

  // 元数据刷新只能推进由自身工作流执行拥有的来源记录检查点；另一执行保留的记录
  // 绝不是可转移证据。
  const foreignRecord = await omdbSourceResult({
    awards: "Foreign execution must not write this.",
  });
  const foreignOwner = omdbExecution("omdb-public-foreign-owner");
  const foreignTarget = omdbExecution("omdb-public-foreign-target");
  await catalogue.createExecution(foreignOwner);
  await retainSourceRecords(catalogue, foreignOwner.id, [foreignRecord.record]);
  await catalogue.createExecution(foreignTarget);
  const foreignHeads = await catalogue.freezeSourceLineageHeads({
    assetId: "omdb-film",
    sourceAssociation: {
      id: "omdb-association",
      subjectId: "omdb-film",
      sourceIdentity: "omdb",
      nativeAddress: "omdb:imdb:tt1234567",
      proposalId: "omdb-initial-proposal",
    },
    coverageIds: [foreignRecord.record.coverage.id],
  });
  const factsBeforeForeignRecord = adoptionFactCounts(root);
  await expect(
    catalogue.applyMetadataRefresh({
      expectedExecution: foreignTarget,
      execution: foreignTarget,
      submission: {
        assetId: "omdb-film",
        sourceAssociation: {
          id: "omdb-association",
          subjectId: "omdb-film",
          sourceIdentity: "omdb",
          nativeAddress: "omdb:imdb:tt1234567",
          proposalId: "omdb-initial-proposal",
        },
        sourceRecords: [foreignRecord.record],
        interpretation: foreignRecord.interpretation,
        expectedLineageHeads: foreignHeads,
      },
    }),
  ).rejects.toThrow("Metadata refresh stale Source Record provenance");
  expect(adoptionFactCounts(root)).toEqual(factsBeforeForeignRecord);
  catalogue.close();
});

it("preflights every Metadata Refresh batch failure before SQLite can write", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const initial = await omdbSourceResult({ awards: "Initial award." });
  await catalogue.createExecution(omdbExecution("preflight-initial"));
  await retainSourceRecords(catalogue, "preflight-initial", [initial.record]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("preflight-initial"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [initial.record.id],
      proposalId: "omdb-initial-proposal",
      acceptedAssetId: "omdb-film",
    },
    accepted: omdbAcceptedRecognition(initial),
  });

  const first = await omdbSourceResult({ awards: "First candidate." });
  const second = await omdbSourceResult({ awards: "Second candidate." });
  const target = omdbExecution("preflight-target");
  await catalogue.createExecution(target);
  await retainSourceRecords(catalogue, target.id, [
    first.record,
    second.record,
  ]);
  const expected = (await catalogue.inspectExecution(target.id))!.execution;
  const association = {
    id: "omdb-association",
    subjectId: "omdb-film",
    sourceIdentity: "omdb",
    nativeAddress: "omdb:imdb:tt1234567",
    proposalId: "omdb-initial-proposal",
  } as const;
  const heads = await catalogue.freezeSourceLineageHeads({
    assetId: "omdb-film",
    sourceAssociation: association,
    coverageIds: [first.record.coverage.id],
  });
  const combinedInterpretation: SourceInterpretationBatch = {
    ...first.interpretation,
    id: "preflight-combined-interpretation",
    sourceRecordIds: [first.record.id, second.record.id],
    metadata: [
      ...first.interpretation.metadata,
      ...second.interpretation.metadata.map((assertion, index) => ({
        ...assertion,
        sourceSlot: `${assertion.sourceSlot}.second-${index}`,
        sourceRecordIds: [second.record.id],
      })),
    ],
  };
  const foreignRecord = await omdbSourceResult({ awards: "Foreign record." });
  const foreignOwner = omdbExecution("preflight-foreign-owner");
  await catalogue.createExecution(foreignOwner);
  await retainSourceRecords(catalogue, foreignOwner.id, [foreignRecord.record]);

  const factsBefore = adoptionFactCounts(root);
  rejectAllMetadataRefreshDml();
  const scenarios: readonly {
    readonly name: string;
    readonly sourceRecords: readonly SourceRecord[];
    readonly interpretation: SourceInterpretationBatch;
    readonly expectedLineageHeads: typeof heads;
    readonly error: string | RegExp;
  }[] = [
    {
      name: "duplicate Source Record IDs",
      sourceRecords: [first.record, first.record],
      interpretation: first.interpretation,
      expectedLineageHeads: heads,
      error: "Metadata refresh has duplicate Source Record IDs",
    },
    {
      name: "duplicate source coverage coordinates",
      sourceRecords: [first.record, second.record],
      interpretation: combinedInterpretation,
      expectedLineageHeads: heads,
      error: "Metadata refresh has duplicate source coverage coordinates",
    },
    {
      name: "duplicate expected lineage heads",
      sourceRecords: [first.record],
      interpretation: first.interpretation,
      expectedLineageHeads: [...heads, ...heads],
      error: "Metadata refresh has duplicate expected source lineage baselines",
    },
    {
      name: "a Source Record retained by another execution",
      sourceRecords: [foreignRecord.record],
      interpretation: foreignRecord.interpretation,
      expectedLineageHeads: heads,
      error: "Metadata refresh stale Source Record provenance",
    },
    {
      name: "a non-canonical retained Source Record payload",
      sourceRecords: [{ ...first.record, body: `${first.record.body} ` }],
      interpretation: first.interpretation,
      expectedLineageHeads: heads,
      error: /conflicts with durable history/u,
    },
    {
      name: "a stale source lineage head",
      sourceRecords: [first.record],
      interpretation: first.interpretation,
      expectedLineageHeads: [
        {
          ...heads[0],
          sourceRecordId: "preflight-not-current",
        },
      ],
      error: "Metadata refresh source lineage is stale",
    },
  ];
  for (const scenario of scenarios) {
    await expect(
      catalogue.applyMetadataRefresh({
        expectedExecution: expected,
        execution: expected,
        submission: {
          assetId: "omdb-film",
          sourceAssociation: association,
          sourceRecords: scenario.sourceRecords,
          interpretation: scenario.interpretation,
          expectedLineageHeads: scenario.expectedLineageHeads,
        },
      }),
      scenario.name,
    ).rejects.toThrow(scenario.error);
    expect(adoptionFactCounts(root), scenario.name).toEqual(factsBefore);
  }
  catalogue.close();
});

it("requires exact interpretation Source Record provenance before Metadata Refresh can write", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const initial = await omdbSourceResult({ awards: "Initial award." });
  const association = {
    id: "omdb-association",
    subjectId: "omdb-film",
    sourceIdentity: "omdb",
    nativeAddress: "omdb:imdb:tt1234567",
    proposalId: "omdb-initial-proposal",
  } as const;
  await catalogue.createExecution(omdbExecution("provenance-initial"));
  await retainSourceRecords(catalogue, "provenance-initial", [initial.record]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("provenance-initial"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [initial.record.id],
      proposalId: association.proposalId,
      acceptedAssetId: "omdb-film",
    },
    accepted: omdbAcceptedRecognition(initial),
  });

  // 建立独立有效的第二覆盖头和事实。下方格式错误候选项不得更改该无关范围。
  const oldOtherScope = withOmdbCoverage(
    await omdbSourceResult({ awards: "Old other-scope award." }),
    "omdb.movie.other-scope",
    "old-other-scope",
  );
  const oldOtherScopeExecution = omdbExecution("provenance-old-other-scope");
  await catalogue.createExecution(oldOtherScopeExecution);
  await retainSourceRecords(catalogue, oldOtherScopeExecution.id, [
    oldOtherScope.record,
  ]);
  const oldOtherScopeExpected = (await catalogue.inspectExecution(
    oldOtherScopeExecution.id,
  ))!.execution;
  await catalogue.applyMetadataRefresh({
    expectedExecution: oldOtherScopeExpected,
    execution: oldOtherScopeExpected,
    submission: {
      assetId: "omdb-film",
      sourceAssociation: association,
      sourceRecords: [oldOtherScope.record],
      interpretation: oldOtherScope.interpretation,
      expectedLineageHeads: await catalogue.freezeSourceLineageHeads({
        assetId: "omdb-film",
        sourceAssociation: association,
        coverageIds: [oldOtherScope.record.coverage.id],
      }),
    },
  });
  const oldOtherScopeBefore = sourceScopeSnapshot(root, {
    subjectId: "omdb-film",
    sourceIdentity: association.sourceIdentity,
    nativeAddress: association.nativeAddress,
    coverageId: oldOtherScope.record.coverage.id,
  });
  expect(oldOtherScopeBefore).toMatchObject({
    head: oldOtherScope.record.id,
    currentMetadata: expect.arrayContaining([
      expect.objectContaining({ value: "Old other-scope award." }),
    ]),
  });

  const primaryCandidate = await omdbSourceResult({
    awards: "New primary-scope award.",
  });
  const otherScopeCandidate = withOmdbCoverage(
    await omdbSourceResult({ awards: "New other-scope award." }),
    oldOtherScope.record.coverage.id,
    "new-other-scope",
  );
  const target = omdbExecution("provenance-target");
  await catalogue.createExecution(target);
  await retainSourceRecords(catalogue, target.id, [
    primaryCandidate.record,
    otherScopeCandidate.record,
  ]);
  const expected = (await catalogue.inspectExecution(target.id))!.execution;
  const heads = await catalogue.freezeSourceLineageHeads({
    assetId: "omdb-film",
    sourceAssociation: association,
    coverageIds: [
      primaryCandidate.record.coverage.id,
      otherScopeCandidate.record.coverage.id,
    ],
  });
  const factsBefore = adoptionFactCounts(root);

  rejectAllMetadataRefreshDml();
  await expect(
    catalogue.applyMetadataRefresh({
      expectedExecution: expected,
      execution: expected,
      submission: {
        assetId: "omdb-film",
        sourceAssociation: association,
        sourceRecords: [primaryCandidate.record, otherScopeCandidate.record],
        interpretation: primaryCandidate.interpretation,
        expectedLineageHeads: heads,
      },
    }),
  ).rejects.toThrow(
    "Metadata refresh interpretation lacks exact Source Record provenance",
  );
  expect(adoptionFactCounts(root)).toEqual(factsBefore);
  expect(
    sourceScopeSnapshot(root, {
      subjectId: "omdb-film",
      sourceIdentity: association.sourceIdentity,
      nativeAddress: association.nativeAddress,
      coverageId: oldOtherScope.record.coverage.id,
    }),
  ).toEqual(oldOtherScopeBefore);

  await expect(
    catalogue.applyMetadataRefresh({
      expectedExecution: expected,
      execution: expected,
      submission: {
        assetId: "omdb-film",
        sourceAssociation: association,
        sourceRecords: [primaryCandidate.record],
        interpretation: {
          ...primaryCandidate.interpretation,
          sourceRecordIds: [
            primaryCandidate.record.id,
            primaryCandidate.record.id,
          ],
        },
        expectedLineageHeads: heads.filter(
          (head) => head.coverageId === primaryCandidate.record.coverage.id,
        ),
      },
    }),
  ).rejects.toThrow(
    "Metadata refresh interpretation has duplicate Source Record IDs",
  );
  expect(adoptionFactCounts(root)).toEqual(factsBefore);
  expect(
    sourceScopeSnapshot(root, {
      subjectId: "omdb-film",
      sourceIdentity: association.sourceIdentity,
      nativeAddress: association.nativeAddress,
      coverageId: oldOtherScope.record.coverage.id,
    }),
  ).toEqual(oldOtherScopeBefore);
  catalogue.close();
});

it("compares a current Source Association against its durable row before Metadata Refresh DML", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const initial = await omdbSourceResult({ awards: "Initial award." });
  const association = {
    id: "omdb-association",
    subjectId: "omdb-film",
    sourceIdentity: "omdb",
    nativeAddress: "omdb:imdb:tt1234567",
    proposalId: "omdb-initial-proposal",
  } as const;
  await catalogue.createExecution(omdbExecution("association-initial"));
  await retainSourceRecords(catalogue, "association-initial", [initial.record]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("association-initial"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [initial.record.id],
      proposalId: association.proposalId,
      acceptedAssetId: "omdb-film",
    },
    accepted: omdbAcceptedRecognition(initial),
  });

  const candidate = await omdbSourceResult({ awards: "Candidate award." });
  const forgedSourceIdentity = "forged-omdb";
  const forgedAddress = "omdb:imdb:forged";
  const forgedSource = withOmdbSourceCoordinate(candidate, {
    suffix: "forged-source-identity",
    sourceIdentity: forgedSourceIdentity,
  });
  const forgedNativeAddress = withOmdbSourceCoordinate(candidate, {
    suffix: "forged-native-address",
    nativeAddress: forgedAddress,
  });
  const target = omdbExecution("association-target");
  await catalogue.createExecution(target);
  await retainSourceRecords(catalogue, target.id, [
    candidate.record,
    forgedSource.record,
    forgedNativeAddress.record,
  ]);
  const expected = (await catalogue.inspectExecution(target.id))!.execution;
  const canonicalHeads = await catalogue.freezeSourceLineageHeads({
    assetId: "omdb-film",
    sourceAssociation: association,
    coverageIds: [candidate.record.coverage.id],
  });

  const scenarios = [
    {
      name: "source identity",
      sourceAssociation: {
        ...association,
        sourceIdentity: forgedSourceIdentity,
      },
      sourceRecords: [forgedSource.record],
      interpretation: forgedSource.interpretation,
      expectedLineageHeads: await catalogue.freezeSourceLineageHeads({
        assetId: "omdb-film",
        sourceAssociation: {
          ...association,
          sourceIdentity: forgedSourceIdentity,
        },
        coverageIds: [candidate.record.coverage.id],
      }),
    },
    {
      name: "native address",
      sourceAssociation: { ...association, nativeAddress: forgedAddress },
      sourceRecords: [forgedNativeAddress.record],
      interpretation: forgedNativeAddress.interpretation,
      expectedLineageHeads: await catalogue.freezeSourceLineageHeads({
        assetId: "omdb-film",
        sourceAssociation: { ...association, nativeAddress: forgedAddress },
        coverageIds: [candidate.record.coverage.id],
      }),
    },
    {
      name: "proposal",
      sourceAssociation: {
        ...association,
        proposalId: "forged-proposal",
      },
      sourceRecords: [candidate.record],
      interpretation: candidate.interpretation,
      expectedLineageHeads: canonicalHeads,
    },
  ] as const;
  const factsBefore = adoptionFactCounts(root);

  rejectAllMetadataRefreshDml();
  const messages = await Promise.all(
    scenarios.map(async (scenario) => {
      try {
        await catalogue.applyMetadataRefresh({
          expectedExecution: expected,
          execution: expected,
          submission: {
            assetId: "omdb-film",
            sourceAssociation: scenario.sourceAssociation,
            sourceRecords: scenario.sourceRecords,
            interpretation: scenario.interpretation,
            expectedLineageHeads: scenario.expectedLineageHeads,
          },
        });
        return `${scenario.name}: unexpectedly succeeded`;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }),
  );
  expect(messages).toEqual([
    "Metadata refresh Source Association conflicts with durable current association",
    "Metadata refresh Source Association conflicts with durable current association",
    "Metadata refresh Source Association conflicts with durable current association",
  ]);
  expect(adoptionFactCounts(root)).toEqual(factsBefore);
  catalogue.close();
});

it("uses only Drizzle writes when Source Enrichment checkpoints real OMDb evidence for recovery", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const baseline = tmdbAcceptedRecognition().accepted;
  const checkpoint = omdbCandidateEnrichmentCheckpoint(baseline);
  const candidate: WorkflowExecution = {
    ...omdbExecution("omdb-checkpoint-execution"),
    dispositions: [{ key: checkpoint.key, status: "running" }],
    sourceEnrichments: [checkpoint],
  };
  const source = await omdbSourceResult({ awards: "Nominated for 1 Oscar." });
  const retainedCheckpoint: Extract<
    SourceEnrichmentCheckpoint,
    { readonly stage: "source-records-retained" }
  > = {
    ...checkpoint,
    stage: "source-records-retained",
    sourceRecordIds: [source.record.id],
    collectionFailures: [],
  };
  const retained: WorkflowExecution = {
    ...candidate,
    stage: "source-records-retained",
    sourceRecordIds: [source.record.id],
    sourceEnrichments: [retainedCheckpoint],
  };
  await catalogue.createExecution(candidate);

  rejectDirectDatabaseWrites();
  await expect(
    catalogue.checkpointSourceEnrichmentRecords({
      expectedExecution: candidate,
      execution: retained,
      sourceRecords: [source.record],
    }),
  ).resolves.toBeUndefined();
  catalogue.close();

  // 授权器也刻意拒绝引导 PRAGMA；重新打开是持久化断言，不属于受守卫检查点写入。
  vi.restoreAllMocks();
  const reopened = SqliteCatalogue.forProductData(root);
  await expect(
    reopened.inspectExecution("omdb-checkpoint-execution"),
  ).resolves.toMatchObject({
    execution: {
      stage: "source-records-retained",
      sourceRecordIds: [source.record.id],
      sourceEnrichments: [
        expect.objectContaining({
          stage: "source-records-retained",
          sourceRecordIds: [source.record.id],
        }),
      ],
    },
    sourceRecords: [expect.objectContaining({ id: source.record.id })],
  });
  reopened.close();
});

it("uses shipped TMDB collection and interpretation while OMDb enrichment establishes an independent association", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const baseline = await tmdbAcceptedRecognitionFromShippedAdapter();

  // 已接受 TMDB 身份刻意不同于下方真实 OMDb 来源：丰富可以新增当前关联，
  // 但绝不能替换证明该主体正当性的识别头。
  await catalogue.createExecution(omdbExecution("tmdb-initial-execution"));
  await retainSourceRecords(catalogue, "tmdb-initial-execution", [
    ...baseline.records,
  ]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("tmdb-initial-execution"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: baseline.records.map((record) => record.id),
      proposalId: baseline.accepted.proposal.id,
      acceptedAssetId: baseline.accepted.entity.id,
    },
    accepted: baseline.accepted,
    metadataPolicyIds: ["ordinary-film-metadata"],
  });

  const initial = await omdbSourceResult({
    title: "OMDb Example Film",
    awards: "Nominated for 1 Oscar.",
  });
  const association = {
    id: "omdb-enrichment-association",
    subjectId: "tmdb-film",
    sourceIdentity: "omdb",
    nativeAddress: "omdb:imdb:tt1234567",
    proposalId: "source-enrichment:omdb-enrichment-execution",
  } as const;
  const pending = omdbEnrichmentExecution({
    id: "omdb-enrichment-execution",
    baseline: baseline.accepted,
    metadataSourceRecordId: baseline.record.id,
    source: initial,
    sourceAssociation: association,
    stage: "association-interpreted",
  });
  const applied = omdbEnrichmentExecution({
    id: "omdb-enrichment-execution",
    baseline: baseline.accepted,
    metadataSourceRecordId: baseline.record.id,
    source: initial,
    sourceAssociation: association,
    stage: "applied",
  });
  await catalogue.createExecution(pending);
  await retainSourceRecords(catalogue, pending.id, [initial.record]);

  rejectDirectDatabaseWrites();

  await expect(
    catalogue.applySourceEnrichment({
      expectedExecution: pending,
      execution: applied,
      expectedRecognitionBaseline: {
        recognitionSourceAssociationId:
          baseline.accepted.recognitionSourceAssociation.id,
        recognitionDecisionId: baseline.accepted.recognitionDecision.id,
      },
      assetId: "tmdb-film",
      sourceAssociation: association,
      sourceRecords: [initial.record],
      interpretation: initial.interpretation,
    }),
  ).resolves.toBeUndefined();

  await expect(
    catalogue.findAcceptedForSubjects(["tmdb-film"]),
  ).resolves.toEqual([
    expect.objectContaining({
      accepted: expect.objectContaining({
        recognitionSourceAssociation:
          baseline.accepted.recognitionSourceAssociation,
        sourceAssociations: expect.arrayContaining([
          baseline.accepted.recognitionSourceAssociation,
          association,
        ]),
        metadata: expect.arrayContaining([
          expect.objectContaining({
            property: "asset.awards",
            value: "Nominated for 1 Oscar.",
            sourceRecordIds: [initial.record.id],
          }),
        ]),
      }),
    }),
  ]);

  // 通过真实产品策略投影持久且独立保留的断言。TMDB 在共享标题和类型组中胜出；
  // OMDb 自己提供断言的地方仍可检查。
  vi.restoreAllMocks();
  const policyWorkflow = composeAssetRefresh(root);
  try {
    const current = await policyWorkflow.listCurrentCatalogue();
    expect(current).toEqual([
      expect.objectContaining({
        entity: { id: "tmdb-film", kind: "digital-asset" },
        effectiveMetadata: expect.arrayContaining([
          expect.objectContaining({
            property: "asset.title",
            value: "Example Film",
            sourceIdentity: "tmdb",
            sourceRecordIds: [baseline.record.id],
            sourceSlot: "tmdb.movie.title",
            alternatives: [
              expect.objectContaining({
                value: "OMDb Example Film",
                sourceIdentity: "omdb",
                sourceRecordIds: [initial.record.id],
                sourceSlot: "omdb.movie.title",
                exclusion: {
                  kind: "source-preference",
                  selectedSource: "tmdb",
                  disagreesWithSelected: true,
                },
              }),
            ],
            reasoning: {
              kind: "source-preference",
              preferredSource: "tmdb",
            },
          }),
          expect.objectContaining({
            property: "asset.awards",
            value: "Nominated for 1 Oscar.",
            sourceIdentity: "omdb",
            sourceRecordIds: [initial.record.id],
            sourceSlot: "omdb.movie.awards",
            alternatives: [],
            reasoning: {
              kind: "source-preference",
              preferredSource: "omdb",
            },
          }),
        ]),
      }),
    ]);
    const genres = current[0]?.effectiveMetadata.filter(
      (metadata) => metadata.property === "asset.genre",
    );
    expect(genres).toEqual([
      expect.objectContaining({
        value: "Drama",
        sourceIdentity: "tmdb",
        sourceRecordIds: [baseline.record.id],
        sourceSlot: "tmdb.movie.genre.0",
        alternatives: [],
        reasoning: {
          kind: "source-preference",
          preferredSource: "tmdb",
        },
      }),
      expect.objectContaining({
        value: "Thriller",
        sourceIdentity: "tmdb",
        sourceRecordIds: [baseline.record.id],
        sourceSlot: "tmdb.movie.genre.1",
        alternatives: [],
        reasoning: {
          kind: "source-preference",
          preferredSource: "tmdb",
        },
      }),
    ]);
  } finally {
    await policyWorkflow.close();
  }
  rejectDirectDatabaseWrites();

  const partialSource = await omdbSourceResult({});
  const partial = {
    ...partialSource,
    record: {
      ...partialSource.record,
      coverage: {
        ...partialSource.record.coverage,
        completeness: "partial" as const,
      },
    },
  };
  const partialRun = await createOmdbSourceRefreshRun({
    catalogue,
    executionId: "omdb-partial-refresh-execution",
    runId: "omdb-partial-refresh-run",
    subjectId: "tmdb-film",
    sourceAssociationId: association.id,
    baselineSourceRecordId: initial.record.id,
  });
  await catalogue.beginSourceRefreshScopeAcquisition({
    runId: partialRun.id,
    coverage: {
      sourceIdentity: partial.record.sourceIdentity,
      nativeAddress: partial.record.nativeAddress,
      coverageId: partial.record.coverage.id,
    },
  });
  await retainSourceRecords(catalogue, "omdb-partial-refresh-execution", [
    partial.record,
  ]);
  const partialStaged = await catalogue.stageSourceRefreshChangeSet({
    runId: partialRun.id,
    candidateSourceRecordId: partial.record.id,
    interpretation: partial.interpretation,
  });
  await expect(
    catalogue.applySourceRefreshChangeSet({
      runId: partialRun.id,
      changeSetId: partialStaged.changeSets[0].id,
    }),
  ).resolves.toMatchObject({ outcome: "succeeded" });

  // 部分记录省略了奖项，但省略不构成缺失声明。
  await expect(
    catalogue.findAcceptedForSubjects(["tmdb-film"]),
  ).resolves.toEqual([
    expect.objectContaining({
      accepted: expect.objectContaining({
        metadata: expect.arrayContaining([
          expect.objectContaining({
            property: "asset.awards",
            value: "Nominated for 1 Oscar.",
          }),
        ]),
      }),
    }),
  ]);

  const complete = await omdbSourceResult({});
  const completeRun = await createOmdbSourceRefreshRun({
    catalogue,
    executionId: "omdb-complete-refresh-execution",
    runId: "omdb-complete-refresh-run",
    subjectId: "tmdb-film",
    sourceAssociationId: association.id,
    baselineSourceRecordId: partial.record.id,
  });
  await catalogue.beginSourceRefreshScopeAcquisition({
    runId: completeRun.id,
    coverage: {
      sourceIdentity: complete.record.sourceIdentity,
      nativeAddress: complete.record.nativeAddress,
      coverageId: complete.record.coverage.id,
    },
  });
  await retainSourceRecords(catalogue, "omdb-complete-refresh-execution", [
    complete.record,
  ]);
  const completeStaged = await catalogue.stageSourceRefreshChangeSet({
    runId: completeRun.id,
    candidateSourceRecordId: complete.record.id,
    interpretation: complete.interpretation,
  });
  expect(completeStaged.changeSets[0]).toMatchObject({
    requiresReview: true,
    changes: expect.arrayContaining([
      expect.objectContaining({ kind: "retracted" }),
    ]),
  });
  await catalogue.reviewSourceRefreshChangeSet({
    runId: completeRun.id,
    changeSetId: completeStaged.changeSets[0].id,
    disposition: "approved",
  });
  await expect(
    catalogue.applySourceRefreshChangeSet({
      runId: completeRun.id,
      changeSetId: completeStaged.changeSets[0].id,
    }),
  ).resolves.toMatchObject({ outcome: "succeeded" });
  await expect(
    catalogue.findAcceptedForSubjects(["tmdb-film"]),
  ).resolves.toEqual([
    expect.objectContaining({
      accepted: expect.objectContaining({
        metadata: expect.not.arrayContaining([
          expect.objectContaining({ property: "asset.awards" }),
        ]),
      }),
    }),
  ]);
  catalogue.close();
});

it("reuses an exact durable enrichment association and rejects a replay before facts grow", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const baseline = tmdbAcceptedRecognition();
  await catalogue.createExecution(omdbExecution("tmdb-replay-initial"));
  await retainSourceRecords(catalogue, "tmdb-replay-initial", [
    baseline.record,
  ]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("tmdb-replay-initial"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [baseline.record.id],
      proposalId: baseline.accepted.proposal.id,
      acceptedAssetId: baseline.accepted.entity.id,
    },
    accepted: baseline.accepted,
  });

  const association = {
    id: "omdb-replayed-association",
    subjectId: "tmdb-film",
    sourceIdentity: "omdb",
    nativeAddress: "omdb:imdb:tt1234567",
    proposalId: "source-enrichment:omdb-replayed-execution",
  } as const;
  // 先前持久检查点可能已包含该精确关联。重新应用其最终效果必须附加它，
  // 而不是再次尝试 `INSERT`。
  catalogue.close();
  const ledger = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    ledger
      .prepare(
        `INSERT INTO source_associations (
          id, subject_id, source_identity, native_address, proposal_id
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        association.id,
        association.subjectId,
        association.sourceIdentity,
        association.nativeAddress,
        association.proposalId,
      );
  } finally {
    ledger.close();
  }

  const source = await omdbSourceResult({ awards: "Won 1 Oscar." });
  const pending = omdbEnrichmentExecution({
    id: "omdb-replayed-execution",
    baseline: baseline.accepted,
    source,
    sourceAssociation: association,
    stage: "association-interpreted",
  });
  const applied = omdbEnrichmentExecution({
    id: "omdb-replayed-execution",
    baseline: baseline.accepted,
    source,
    sourceAssociation: association,
    stage: "applied",
  });
  await catalogue.createExecution(pending);
  await retainSourceRecords(catalogue, pending.id, [source.record]);
  rejectDirectDatabaseWrites();

  const input = {
    expectedExecution: pending,
    execution: applied,
    expectedRecognitionBaseline: {
      recognitionSourceAssociationId:
        baseline.accepted.recognitionSourceAssociation.id,
      recognitionDecisionId: baseline.accepted.recognitionDecision.id,
    },
    assetId: "tmdb-film",
    sourceAssociation: association,
    sourceRecords: [source.record],
    interpretation: source.interpretation,
  } as const;
  await expect(catalogue.applySourceEnrichment(input)).resolves.toBeUndefined();
  const first = await catalogue.findAcceptedForSubjects(["tmdb-film"]);
  expect(first[0]?.accepted.sourceAssociations).toEqual(
    expect.arrayContaining([association]),
  );

  // 后续可选丰富并非来源刷新：它不能静默向同一个来源覆盖坐标追加第二条记录。
  // 谱系拒绝必须发生在它新增关联或事实之前。
  const laterSource = await omdbSourceResult({ awards: "Different award." });
  const laterPending = omdbEnrichmentExecution({
    id: "omdb-replayed-lineage-execution",
    baseline: baseline.accepted,
    source: laterSource,
    sourceAssociation: association,
    stage: "association-interpreted",
  });
  const laterApplied = omdbEnrichmentExecution({
    id: "omdb-replayed-lineage-execution",
    baseline: baseline.accepted,
    source: laterSource,
    sourceAssociation: association,
    stage: "applied",
  });
  await catalogue.createExecution(laterPending);
  await retainSourceRecords(catalogue, laterPending.id, [laterSource.record]);
  const factsBeforeLineageConflict = adoptionFactCounts(root);
  await expect(
    catalogue.applySourceEnrichment({
      expectedExecution: laterPending,
      execution: laterApplied,
      expectedRecognitionBaseline: {
        recognitionSourceAssociationId:
          baseline.accepted.recognitionSourceAssociation.id,
        recognitionDecisionId: baseline.accepted.recognitionDecision.id,
      },
      assetId: "tmdb-film",
      sourceAssociation: association,
      sourceRecords: [laterSource.record],
      interpretation: laterSource.interpretation,
    }),
  ).rejects.toThrow("Source Enrichment source lineage baseline is stale");
  expect(adoptionFactCounts(root)).toEqual(factsBeforeLineageConflict);

  await expect(catalogue.applySourceEnrichment(input)).rejects.toThrow(
    "execution baseline is stale or terminal",
  );
  await expect(
    catalogue.findAcceptedForSubjects(["tmdb-film"]),
  ).resolves.toEqual(first);
  catalogue.close();
});

it("rejects an enrichment identity conflict when another current subject already owns the canonical OMDb coordinate", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);

  // 资产 A 已经通过当前来源关联跟随该精确 OMDb 坐标。资产 B 拥有独立的 TMDB 识别头。
  const ownerSource = await omdbSourceResult({ awards: "Owner award." });
  await catalogue.createExecution(omdbExecution("omdb-owner-initial"));
  await retainSourceRecords(catalogue, "omdb-owner-initial", [
    ownerSource.record,
  ]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("omdb-owner-initial"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [ownerSource.record.id],
      proposalId: "omdb-initial-proposal",
      acceptedAssetId: "omdb-film",
    },
    accepted: omdbAcceptedRecognition(ownerSource),
  });

  const target = tmdbAcceptedRecognition();
  await catalogue.createExecution(omdbExecution("tmdb-target-initial"));
  await retainSourceRecords(catalogue, "tmdb-target-initial", [target.record]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("tmdb-target-initial"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [target.record.id],
      proposalId: target.accepted.proposal.id,
      acceptedAssetId: target.accepted.entity.id,
    },
    accepted: target.accepted,
  });

  const conflictingSource = await omdbSourceResult({
    awards: "This must not become B metadata.",
  });
  const association = {
    id: "omdb-conflicting-target-association",
    subjectId: target.accepted.entity.id,
    sourceIdentity: "omdb",
    nativeAddress: "omdb:imdb:tt1234567",
    proposalId: "source-enrichment:omdb-target-conflict",
  } as const;
  const pending = omdbEnrichmentExecution({
    id: "omdb-target-conflict",
    baseline: target.accepted,
    source: conflictingSource,
    sourceAssociation: association,
    stage: "association-interpreted",
  });
  const applied = omdbEnrichmentExecution({
    id: "omdb-target-conflict",
    baseline: target.accepted,
    source: conflictingSource,
    sourceAssociation: association,
    stage: "applied",
  });
  await catalogue.createExecution(pending);
  await retainSourceRecords(catalogue, pending.id, [conflictingSource.record]);

  const factsBefore = adoptionFactCounts(root);
  rejectAllMetadataRefreshDml();
  await expect(
    catalogue.applySourceEnrichment({
      expectedExecution: pending,
      execution: applied,
      expectedRecognitionBaseline: {
        recognitionSourceAssociationId:
          target.accepted.recognitionSourceAssociation.id,
        recognitionDecisionId: target.accepted.recognitionDecision.id,
      },
      assetId: target.accepted.entity.id,
      sourceAssociation: association,
      sourceRecords: [conflictingSource.record],
      interpretation: conflictingSource.interpretation,
    }),
  ).rejects.toThrow("Source Enrichment identity conflict");
  expect(adoptionFactCounts(root)).toEqual(factsBefore);
  await expect(catalogue.inspectExecution(pending.id)).resolves.toMatchObject({
    execution: { status: "running", stage: "source-records-retained" },
  });
  catalogue.close();
});

it("preflights an enrichment batch before creating its optional association", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const baseline = tmdbAcceptedRecognition();
  await catalogue.createExecution(omdbExecution("enrichment-preflight-seed"));
  await retainSourceRecords(catalogue, "enrichment-preflight-seed", [
    baseline.record,
  ]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("enrichment-preflight-seed"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [baseline.record.id],
      proposalId: baseline.accepted.proposal.id,
      acceptedAssetId: baseline.accepted.entity.id,
    },
    accepted: baseline.accepted,
  });

  const first = await omdbSourceResult({ awards: "First duplicate scope." });
  const second = await omdbSourceResult({ awards: "Second duplicate scope." });
  const interpretation: SourceInterpretationBatch = {
    ...first.interpretation,
    id: "enrichment-preflight-duplicate-scope",
    sourceRecordIds: [first.record.id, second.record.id],
    metadata: [
      ...first.interpretation.metadata,
      ...second.interpretation.metadata.map((assertion, index) => ({
        ...assertion,
        sourceSlot: `${assertion.sourceSlot}.second-${index}`,
        sourceRecordIds: [second.record.id],
      })),
    ],
  };
  const association = {
    id: "enrichment-preflight-association",
    subjectId: baseline.accepted.entity.id,
    sourceIdentity: "omdb",
    nativeAddress: "omdb:imdb:tt1234567",
    proposalId: "source-enrichment:preflight-duplicate-scope",
  } as const;
  const pendingBase = omdbEnrichmentExecution({
    id: "enrichment-preflight-duplicate-scope",
    baseline: baseline.accepted,
    source: first,
    sourceAssociation: association,
    stage: "association-interpreted",
  });
  const pending: WorkflowExecution = {
    ...pendingBase,
    sourceRecordIds: [first.record.id, second.record.id],
    sourceEnrichments: pendingBase.sourceEnrichments?.map((checkpoint) => ({
      ...checkpoint,
      interpretation,
      sourceRecordIds: [first.record.id, second.record.id],
    })),
  };
  const appliedBase = omdbEnrichmentExecution({
    id: pending.id,
    baseline: baseline.accepted,
    source: first,
    sourceAssociation: association,
    stage: "applied",
  });
  const applied: WorkflowExecution = {
    ...appliedBase,
    sourceRecordIds: [first.record.id, second.record.id],
    sourceEnrichments: appliedBase.sourceEnrichments?.map((checkpoint) => ({
      ...checkpoint,
      interpretation,
      sourceRecordIds: [first.record.id, second.record.id],
    })),
  };
  await catalogue.createExecution(pending);
  await retainSourceRecords(catalogue, pending.id, [
    first.record,
    second.record,
  ]);

  const factsBefore = adoptionFactCounts(root);
  rejectAllMetadataRefreshDml();
  await expect(
    catalogue.applySourceEnrichment({
      expectedExecution: pending,
      execution: applied,
      expectedRecognitionBaseline: {
        recognitionSourceAssociationId:
          baseline.accepted.recognitionSourceAssociation.id,
        recognitionDecisionId: baseline.accepted.recognitionDecision.id,
      },
      assetId: baseline.accepted.entity.id,
      sourceAssociation: association,
      sourceRecords: [first.record, second.record],
      interpretation,
    }),
  ).rejects.toThrow(
    "Metadata refresh has duplicate source coverage coordinates",
  );
  expect(adoptionFactCounts(root)).toEqual(factsBefore);
  await expect(catalogue.inspectExecution(pending.id)).resolves.toMatchObject({
    execution: { status: "running", stage: "source-records-retained" },
  });
  catalogue.close();
});

it("scopes complete OMDb omissions to one subject record chain while retaining other current subjects", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);

  // 这些刻意采用由识别创建的/旧版重复规范坐标。丰富闸门不参与：
  // 本测试只验证公开元数据刷新谱系行为。
  const ownerSource = await omdbSourceResult({ awards: "A award." });
  const owner = omdbAcceptedRecognitionForAsset({
    source: ownerSource,
    assetId: "lineage-a-film",
    associationId: "lineage-a-omdb-association",
    proposalId: "lineage-a-omdb-proposal",
    decisionId: "lineage-a-omdb-decision",
    secondary: { id: "lineage-a-secondary", label: "A secondary fact" },
  });
  await catalogue.createExecution(omdbExecution("lineage-a-initial"));
  await retainSourceRecords(catalogue, "lineage-a-initial", [
    ownerSource.record,
  ]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("lineage-a-initial"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [ownerSource.record.id],
      proposalId: owner.proposal.id,
      acceptedAssetId: owner.entity.id,
    },
    accepted: owner,
  });

  const legacyIdentity = await omdbSourceResult({ title: "B identity" });
  const legacySource = {
    ...legacyIdentity,
    record: {
      ...legacyIdentity.record,
      coverage: { ...legacyIdentity.record.coverage, id: "omdb.identity" },
    },
    interpretation: {
      ...legacyIdentity.interpretation,
      id: "lineage-b-identity-interpretation",
    },
  };
  const target = omdbAcceptedRecognitionForAsset({
    source: legacySource,
    assetId: "lineage-b-film",
    associationId: "lineage-b-omdb-association",
    proposalId: "lineage-b-omdb-proposal",
    decisionId: "lineage-b-omdb-decision",
  });
  await catalogue.createExecution(omdbExecution("lineage-b-initial"));
  await retainSourceRecords(catalogue, "lineage-b-initial", [
    legacySource.record,
  ]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("lineage-b-initial"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [legacySource.record.id],
      proposalId: target.proposal.id,
      acceptedAssetId: target.entity.id,
    },
    accepted: target,
  });

  // B 打开全新的 `omdb.movie` 谱系。这里的完整省略不得扫描或撤回 A 独立拥有的
  // `omdb.movie` 谱系。
  const firstBRecord = await omdbSourceResult({ awards: "B award." });
  const bSecondary = {
    id: "lineage-b-secondary",
    kind: "entity" as const,
    sourceIdentity: "omdb",
    sourceKey: "lineage-b-secondary",
    identityNamespace: "omdb.test.secondary",
    label: "B secondary fact",
    sourceRecordIds: [firstBRecord.record.id],
  };
  const firstBInterpretation: SourceInterpretationBatch = {
    ...firstBRecord.interpretation,
    id: "lineage-b-first-movie-interpretation",
    metadata: [
      ...firstBRecord.interpretation.metadata,
      {
        subjectId: bSecondary.id,
        property: "asset.secondary-label",
        sourceSlot: "omdb.movie.secondary-label",
        value: "B secondary fact",
        sourceRecordIds: [firstBRecord.record.id],
      },
    ],
    entities: [bSecondary],
    relationships: [
      {
        subjectId: bSecondary.id,
        participantId: bSecondary.id,
        type: "asset.related",
        role: "secondary",
        sourceSlot: "omdb.movie.secondary-relationship",
        sourceRecordIds: [firstBRecord.record.id],
      },
    ],
  };
  const firstBExecution = omdbExecution("lineage-b-first-movie");
  await catalogue.createExecution(firstBExecution);
  await retainSourceRecords(catalogue, firstBExecution.id, [
    firstBRecord.record,
  ]);
  const firstBPending = (await catalogue.inspectExecution(firstBExecution.id))!
    .execution;
  const firstBHeads = await catalogue.freezeSourceLineageHeads({
    assetId: target.entity.id,
    sourceAssociation: target.recognitionSourceAssociation,
    coverageIds: [firstBRecord.record.coverage.id],
  });
  expect(firstBHeads).toEqual([
    {
      sourceIdentity: "omdb",
      nativeAddress: "omdb:imdb:tt1234567",
      coverageId: "omdb.movie",
    },
  ]);
  await catalogue.applyMetadataRefresh({
    expectedExecution: firstBPending,
    execution: firstBPending,
    submission: {
      assetId: target.entity.id,
      sourceAssociation: target.recognitionSourceAssociation,
      sourceRecords: [firstBRecord.record],
      interpretation: firstBInterpretation,
      expectedLineageHeads: firstBHeads,
    },
  });

  // 现在 B 用完整省略推进自己的现有头部。它必须撤回 B 的根和来源次要事实；
  // 即使来源坐标相同，也应保持 A 的根和来源次要事实不变。
  const secondBRecord = await omdbSourceResult({});
  const secondBInterpretation: SourceInterpretationBatch = {
    ...secondBRecord.interpretation,
    id: "lineage-b-second-movie-interpretation",
    metadata: [],
    sourceArtifacts: [],
    entities: [],
    relationships: [],
  };
  const secondBExecution = omdbExecution("lineage-b-second-movie");
  await catalogue.createExecution(secondBExecution);
  await retainSourceRecords(catalogue, secondBExecution.id, [
    secondBRecord.record,
  ]);
  const secondBPending = (await catalogue.inspectExecution(
    secondBExecution.id,
  ))!.execution;
  const secondBHeads = await catalogue.freezeSourceLineageHeads({
    assetId: target.entity.id,
    sourceAssociation: target.recognitionSourceAssociation,
    coverageIds: [secondBRecord.record.coverage.id],
  });
  expect(secondBHeads).toEqual([
    expect.objectContaining({ sourceRecordId: firstBRecord.record.id }),
  ]);
  await catalogue.applyMetadataRefresh({
    expectedExecution: secondBPending,
    execution: secondBPending,
    submission: {
      assetId: target.entity.id,
      sourceAssociation: target.recognitionSourceAssociation,
      sourceRecords: [secondBRecord.record],
      interpretation: secondBInterpretation,
      expectedLineageHeads: secondBHeads,
    },
  });

  const ledger = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    const assertionId = (subjectId: string, value: string) =>
      (
        ledger
          .prepare(
            `SELECT id FROM metadata_assertions
             WHERE subject_id = ? AND value = ? ORDER BY id LIMIT 1`,
          )
          .get(subjectId, value) as { readonly id: number } | undefined
      )?.id;
    const retracted = (id: number | undefined) =>
      id === undefined
        ? undefined
        : (ledger
            .prepare(
              `SELECT source_record_id FROM metadata_assertion_retractions
               WHERE assertion_id = ?`,
            )
            .get(id) as { readonly source_record_id: string } | undefined);
    expect(retracted(assertionId(owner.entity.id, "A award."))).toBeUndefined();
    expect(
      retracted(assertionId("lineage-a-secondary", "A secondary fact")),
    ).toBeUndefined();
    expect(retracted(assertionId(target.entity.id, "B award."))).toEqual({
      source_record_id: secondBRecord.record.id,
    });
    expect(
      retracted(assertionId("lineage-b-secondary", "B secondary fact")),
    ).toEqual({ source_record_id: secondBRecord.record.id });
    expect(
      ledger
        .prepare(
          `SELECT source_record_id FROM relationship_retractions
           WHERE relationship_id IN (
             SELECT relationship.id
             FROM entity_relationships relationship
             JOIN relationship_lifecycles lifecycle
               ON lifecycle.relationship_id = relationship.id
             WHERE relationship.subject_id = ? AND lifecycle.source_slot = ?
           )`,
        )
        .get("lineage-b-secondary", "omdb.movie.secondary-relationship"),
    ).toEqual({ source_record_id: secondBRecord.record.id });
  } finally {
    ledger.close();
  }
  catalogue.close();
});

it("uses only Drizzle writes when a checkpointed OMDb artifact commits to its current source association", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const source = await omdbSourceResult({
    awards: "Won 1 Oscar.",
    poster: "https://m.media-amazon.com/images/example-poster.jpg",
  });
  const candidate = source.interpretation.sourceArtifacts[0];
  if (candidate === undefined) {
    throw new Error("OMDb fixture did not expose a source-artifact candidate");
  }
  await catalogue.createExecution(omdbExecution("omdb-artifact-initial"));
  await retainSourceRecords(catalogue, "omdb-artifact-initial", [
    source.record,
  ]);
  await acceptRecognition(catalogue, {
    execution: {
      ...omdbExecution("omdb-artifact-initial"),
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: [source.record.id],
      proposalId: "omdb-initial-proposal",
      acceptedAssetId: "omdb-film",
    },
    accepted: omdbAcceptedRecognition(source),
  });

  const stored = omdbManagedArtifactExecution({
    id: "omdb-artifact-commit",
    sourceRecordId: source.record.id,
    candidate,
  });
  const completed: WorkflowExecution = {
    ...stored,
    status: "completed",
    stage: "completed",
    outcome: "accepted",
    acceptedAssetId: "omdb-film",
  };
  await catalogue.createExecution(stored);
  const managedArtifacts = omdbManagedArtifactFacts({
    subjectId: "omdb-film",
    sourceRecordId: source.record.id,
  });
  const stale = omdbManagedArtifactExecution({
    id: "omdb-artifact-stale",
    sourceRecordId: source.record.id,
    candidate,
  });
  await catalogue.createExecution(stale);
  const staleExpected = await executionBaseline(catalogue, stale.id);
  await catalogue.transitionExecution(stale, {
    ...stale,
    stage: "source-artifacts-acquired",
  });
  const wrongSubject = omdbManagedArtifactExecution({
    id: "omdb-artifact-wrong-subject",
    sourceRecordId: source.record.id,
    candidate,
  });
  await catalogue.createExecution(wrongSubject);

  rejectDirectDatabaseWrites();
  await expect(
    catalogue.submitManagedSourceArtifacts({
      expectedExecution: await executionBaseline(catalogue, stored.id),
      execution: completed,
      expectedIdentity: {
        subjectId: "omdb-film",
        recognitionDecisionId: "omdb-decision",
        sourceAssociationId: "omdb-association",
      },
      sourceRecordIds: [source.record.id],
      managedArtifacts,
    }),
  ).resolves.toBeUndefined();
  await expect(
    catalogue.findAcceptedForSubjects(["omdb-film"]),
  ).resolves.toEqual([
    expect.objectContaining({
      accepted: expect.objectContaining({
        artifactAssociations: expect.arrayContaining([
          expect.objectContaining({
            id: "omdb-managed-association",
            subjectId: "omdb-film",
            sourceAssociationId: "omdb-association",
            sourceRecordIds: [source.record.id],
          }),
        ]),
      }),
    }),
  ]);

  const beforeStale = await catalogue.findAcceptedForSubjects(["omdb-film"]);
  await expect(
    catalogue.submitManagedSourceArtifacts({
      expectedExecution: staleExpected,
      execution: {
        ...completed,
        id: stale.id,
      },
      expectedIdentity: {
        subjectId: "omdb-film",
        recognitionDecisionId: "omdb-decision",
        sourceAssociationId: "omdb-association",
      },
      sourceRecordIds: [source.record.id],
      managedArtifacts: omdbManagedArtifactFacts({
        subjectId: "omdb-film",
        sourceRecordId: source.record.id,
        suffix: "stale",
      }),
    }),
  ).rejects.toThrow("execution baseline is stale or terminal");
  await expect(
    catalogue.findAcceptedForSubjects(["omdb-film"]),
  ).resolves.toEqual(beforeStale);
  await expect(
    catalogue.submitManagedSourceArtifacts({
      expectedExecution: await executionBaseline(catalogue, wrongSubject.id),
      execution: {
        ...completed,
        id: wrongSubject.id,
      },
      expectedIdentity: {
        subjectId: "omdb-film",
        recognitionDecisionId: "omdb-decision",
        sourceAssociationId: "omdb-association",
      },
      sourceRecordIds: [source.record.id],
      managedArtifacts: omdbManagedArtifactFacts({
        subjectId: "wrong-subject",
        sourceRecordId: source.record.id,
        suffix: "wrong-subject",
      }),
    }),
  ).rejects.toThrow(
    "Managed source-artifact association lacks current source provenance",
  );
  await expect(
    catalogue.findAcceptedForSubjects(["omdb-film"]),
  ).resolves.toEqual(beforeStale);
  catalogue.close();
});

it("does not expose a native driver to a Drizzle transaction helper", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);

  await catalogue.listExecutions();
  await catalogue.createExecution(runningExecution());
  await retainSourceRecords(catalogue, "dlsite-execution", [sourceRecord()]);
  let receivedTransaction: unknown;
  const unsafe = catalogue as unknown as {
    insertProposalWithDrizzle(transaction: unknown): void;
  };
  unsafe.insertProposalWithDrizzle = (transaction) => {
    receivedTransaction = transaction;
    throw new Error("test transaction stop");
  };

  await expect(
    acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: acceptedRecognition(),
    }),
  ).rejects.toThrow("test transaction stop");
  expect(receivedTransaction).not.toHaveProperty("prepare");
  expect(adoptionFactCounts(root)).toEqual(emptyAdoptionFactCounts());
  catalogue.close();
});

it("keeps public manual and automatic refresh execution writes inside Drizzle", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const observedRootRegistrations = instrumentedObservedRootRegistrations();
  const manualAndAutomatic = instrumentedRecognitionWorkflow(catalogue, {
    observedRootRegistrations,
  });
  const workflow = attachAssetRefreshAutomation(
    manualAndAutomatic,
    new AssetRefreshAutomation(manualAndAutomatic, {
      executionQueries: catalogue,
      automationQueries: catalogue,
      // 本测试刻意使用内存观察根夹具来隔离 Drizzle 写入边界。
      // 真实根授权由 `SqliteCatalogue` 生命周期测试覆盖。
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
      recognitionPolicyVersion: "instrumented-dlsite-policy/1",
    }),
  );

  // 验证实际应用层路径前，先准备数据库模式/迁移状态。即使从 Drizzle 回调内部发出，
  // 守卫也会拒绝原始 DML 和事务。
  await catalogue.listExecutions();
  rejectDirectDatabaseWrites();

  const manual = await scanInstrumentedObservedScope(workflow, {
    directory: "/observed/manual",
    acceptTrusted: true,
    executionId: "manual-drizzle-execution",
  });
  expect(manual.execution).toMatchObject({
    id: "manual-drizzle-execution",
    status: "completed",
    snapshot: { root: "/observed/manual" },
  });

  const enabled = await workflow.enableAutomation({
    observedRootId: "automatic",
    relativeScope: ".",
    intervalMilliseconds: 1_000,
    acceptTrusted: true,
    runInitial: false,
  });
  const automatic = await workflow.triggerAutomation(
    enabled.intent.id,
    "scan-now",
    new Date("2026-08-02T00:00:00.000Z"),
  );
  expect(automatic).toMatchObject({
    status: "started",
    execution: {
      execution: {
        automationIntentId: enabled.intent.id,
        workflowInput: { trigger: "scan-now" },
      },
    },
  });
  if (automatic.status !== "started") throw new Error("missing execution");
  await expect(
    catalogue.inspectExecution(automatic.execution.execution.id),
  ).resolves.toMatchObject({
    execution: {
      automationIntentId: enabled.intent.id,
      workflowInput: { trigger: "scan-now" },
      selection: { directory: "/observed/automatic" },
      compatibility: {
        workflowVersion: "asset-refresh/2",
        capabilityCoordinates: expect.any(Array),
      },
    },
  });
  catalogue.close();
});

it("keeps recovery lease claim, renewal, and release writes inside Drizzle", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  let authoritativeNow = new Date("2026-08-02T00:00:00.000Z");
  const catalogue = SqliteCatalogue.forProductData(root, {
    clock: { now: () => authoritativeNow },
  });
  const running = { ...runningExecution(), id: "drizzle-recovery-lease" };

  await catalogue.listExecutions();
  await catalogue.createExecution(running);
  rejectDirectDatabaseWrites();

  await expect(
    catalogue.claimResumeExecution({
      executionId: running.id,
      token: "lease-owner",
      now: "2026-08-02T00:00:00.000Z",
      expiresAt: "2026-08-02T00:01:00.000Z",
    }),
  ).resolves.toBe("claimed");
  await expect(
    catalogue.renewResumeExecutionClaim({
      executionId: running.id,
      token: "lease-owner",
      now: "2026-08-02T00:00:30.000Z",
      expiresAt: "2026-08-02T00:02:00.000Z",
    }),
  ).resolves.toBe(true);
  authoritativeNow = new Date("2026-08-02T00:00:30.000Z");
  await expect(
    catalogue.releaseResumeExecutionClaim({
      executionId: running.id,
      token: "lease-owner",
    }),
  ).resolves.toBeUndefined();
  catalogue.close();
});

it("keeps Automation Intent enablement inside Drizzle", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);

  await catalogue.listExecutions();
  await catalogue.createAutomationIntentForTesting({
    id: "drizzle-automation-intent",
    scope: { observedRootId: "drizzle-observed-root", relativeScope: "." },
    enabled: true,
    intervalMilliseconds: 60_000,
    workflowInputVersion: "asset-refresh-input/1",
    runInitial: false,
    policyReferences: ["recognition"],
    acceptTrusted: false,
  });
  rejectDirectDatabaseWrites();

  await catalogue.setAutomationIntentEnabled(
    "drizzle-automation-intent",
    false,
  );
  await expect(
    catalogue.inspectAutomationIntent("drizzle-automation-intent"),
  ).resolves.toMatchObject({ enabled: false });
  catalogue.close();
});

it("keeps disposable tooling on the explicit SQLite testing subpath", async () => {
  const [runtimeModule, testingModule, declaredExports, packageManifest] =
    await Promise.all([
      import("@digital/sqlite"),
      import("@digital/sqlite/testing"),
      declaredPackageExports(
        new URL("../../sqlite/dist/index.d.ts", import.meta.url),
      ),
      readFile(new URL("../../sqlite/package.json", import.meta.url), "utf8"),
    ]);
  const runtimeExports = ["SqliteCatalogue"];
  const testingExports = [
    "disposableCatalogueTarget",
    "disposableCatalogueTargetFromEnvironment",
    "disposableProductDataCatalogueTarget",
    "disposableProductDataCatalogueTargetFromEnvironment",
    "inspectSqliteSchema",
    "isPreparedCatalogue",
    "prepareDisposableCatalogue",
    "prepareDisposableProductDataCatalogue",
  ];
  const compareExportNames = (left: string, right: string): number =>
    left.localeCompare(right);

  expect(Object.keys(runtimeModule).toSorted(compareExportNames)).toEqual(
    runtimeExports.toSorted(compareExportNames),
  );
  expect(Object.keys(testingModule).toSorted(compareExportNames)).toEqual(
    testingExports.toSorted(compareExportNames),
  );
  expect([...declaredExports].toSorted(compareExportNames)).toEqual(
    [
      ...runtimeExports,
      "SqliteCatalogueClock",
      "SqliteCatalogueOptions",
    ].toSorted(compareExportNames),
  );
  expect(JSON.parse(packageManifest).exports).toEqual({
    ".": {
      "digital-source": "./src/index.ts",
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
    "./testing": {
      "digital-source": "./src/testing.ts",
      types: "./dist/testing.d.ts",
      default: "./dist/testing.js",
    },
  });
  const internalImport = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'await import("@digital/sqlite/workflow-execution-persistence")',
    ],
    {
      cwd: import.meta.dirname,
      encoding: "utf8",
    },
  );
  expect(internalImport.status).toBe(1);
  expect(internalImport.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
});

it("uses SQLite authorization actions for direct-write spellings a prefix guard misses", () => {
  const dml = new DatabaseSync(":memory:");
  const savepoint = new DatabaseSync(":memory:");
  const transaction = new DatabaseSync(":memory:");
  const schema = new DatabaseSync(":memory:");
  try {
    dml.exec(
      "CREATE TABLE guarded (id INTEGER); INSERT INTO guarded VALUES (1)",
    );
    savepoint.exec("SAVEPOINT direct_guard");
    transaction.exec("BEGIN");
    rejectDirectDatabaseWrites();

    // BOM、注释、空语句和 CTE 都无法对 SQLite 隐藏 DML。
    expect(() =>
      dml.exec(
        "\uFEFF/* leading */; -- a prefix parser would stop here\nWITH source(id) AS (SELECT 1) INSERT INTO guarded SELECT id FROM source",
      ),
    ).toThrow(/raw DatabaseSync write escaped Drizzle \(SQLITE_INSERT/u);
    expect(() =>
      dml.exec(
        "-- leading comment\n/* block */ WITH source(id) AS (SELECT 1) UPDATE guarded SET id = id + 1",
      ),
    ).toThrow(/raw DatabaseSync write escaped Drizzle \(SQLITE_UPDATE/u);
    expect(() =>
      dml.exec(
        ";WITH source(id) AS (SELECT 1) DELETE FROM guarded WHERE id IN (SELECT id FROM source)",
      ),
    ).toThrow(/raw DatabaseSync write escaped Drizzle \(SQLITE_DELETE/u);

    expect(() => savepoint.exec("SAVEPOINT nested_guard")).toThrow(
      /raw DatabaseSync write escaped Drizzle \(SQLITE_SAVEPOINT/u,
    );
    expect(() => savepoint.exec("RELEASE direct_guard")).toThrow(
      /raw DatabaseSync write escaped Drizzle \(SQLITE_SAVEPOINT/u,
    );
    expect(() => transaction.exec("END")).toThrow(
      /raw DatabaseSync write escaped Drizzle \(SQLITE_TRANSACTION/u,
    );
    expect(() =>
      schema.exec("/* schema */ CREATE TABLE forbidden (id INTEGER)"),
    ).toThrow(/raw DatabaseSync write escaped Drizzle/u);
    expect(() => schema.exec("PRAGMA user_version = 1")).toThrow(
      /raw DatabaseSync write escaped Drizzle \(SQLITE_PRAGMA/u,
    );
  } finally {
    dml.close();
    savepoint.close();
    transaction.close();
    schema.close();
  }
});

it("rolls back the complete Drizzle adoption batch when a durable fact conflicts", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);

  await catalogue.listExecutions();
  await catalogue.createExecution(runningExecution());
  await retainSourceRecords(catalogue, "dlsite-execution", [sourceRecord()]);

  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    database.exec(
      "CREATE TRIGGER reject_drizzle_artifacts BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'planned Drizzle adoption failure'); END",
    );
  } finally {
    database.close();
  }
  rejectDirectDatabaseWrites();

  await expect(
    acceptRecognition(catalogue, {
      execution: acceptedExecution(),
      accepted: acceptedRecognition(),
    }),
  ).rejects.toThrow("planned Drizzle adoption failure");

  const inspection = await catalogue.inspectExecution("dlsite-execution");
  expect(inspection?.execution.status).toBe("running");
  expect(inspection?.proposal).toBeUndefined();
  expect(inspection?.accepted).toBeUndefined();
  expect(adoptionFactCounts(root)).toEqual(emptyAdoptionFactCounts());
  catalogue.close();
});

it("uses only Drizzle writes across the complete initial recognition route", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const workflow = instrumentedRecognitionWorkflow(catalogue);

  // 引导位于受观察路径之外；从第一个执行检查点起，每次 `DatabaseSync` 写入都必须源自 Drizzle。
  await catalogue.listExecutions();
  const originalAcceptance = catalogue.acceptRecognition.bind(catalogue);
  let expectedAcceptance: WorkflowExecution | undefined;
  let durableAcceptance: WorkflowExecution | undefined;
  (
    catalogue as unknown as {
      acceptRecognition(
        input: Parameters<SqliteCatalogue["acceptRecognition"]>[0],
      ): Promise<void>;
    }
  ).acceptRecognition = async (input) => {
    expectedAcceptance = input.expectedExecution;
    durableAcceptance = (
      await catalogue.inspectExecution(input.expectedExecution.id)
    )?.execution;
    await originalAcceptance(input);
  };
  rejectDirectDatabaseWrites();

  const result = await scanInstrumentedObservedScope(workflow, {
    directory: "/observed/RJ01668691",
    executionId: "instrumented-initial-scan",
    acceptTrusted: true,
    informationRequirement: recognitionInformationRequirement(),
  });

  expect(durableAcceptance).toEqual(expectedAcceptance);
  expect(result.execution.reason).toBeUndefined();
  expect(result.execution.outcome).toBe("accepted");
  expect(result.accepted?.entity.kind).toBe("digital-asset");
  expect(result.accepted?.artifactAssociations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: "asset.primary-cover" }),
    ]),
  );
  catalogue.close();
});

it("rejects an Application acceptance when its carried persisted baseline loses a race", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const workflow = instrumentedRecognitionWorkflow(catalogue);

  await catalogue.listExecutions();
  const originalAcceptance = catalogue.acceptRecognition.bind(catalogue);
  let raced = false;
  (
    catalogue as unknown as {
      acceptRecognition(
        input: Parameters<SqliteCatalogue["acceptRecognition"]>[0],
      ): Promise<void>;
    }
  ).acceptRecognition = async (input) => {
    raced = true;
    await catalogue.transitionExecution(input.expectedExecution, {
      ...input.expectedExecution,
      stage: "recognition",
      reason: "concurrent checkpoint",
    });
    await originalAcceptance(input);
  };

  const result = await scanInstrumentedObservedScope(workflow, {
    directory: "/observed/RJ01668691",
    executionId: "instrumented-cas-race",
    acceptTrusted: true,
    informationRequirement: recognitionInformationRequirement(),
  });

  expect(raced).toBe(true);
  expect(result.execution).toMatchObject({
    outcome: "failed",
    reason:
      "Workflow Execution instrumented-cas-race execution baseline is stale or terminal",
  });
  expect(adoptionFactCounts(root)).toEqual(emptyAdoptionFactCounts());
  expect(
    (await catalogue.inspectExecution(result.execution.id))?.execution,
  ).toMatchObject({
    status: "failed",
    reason:
      "Workflow Execution instrumented-cas-race execution baseline is stale or terminal",
  });
  catalogue.close();
});

it("uses only Drizzle writes across trusted explicit-work-plan acceptance", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const workflow = instrumentedRecognitionWorkflow(catalogue, {
    explicitWorkPlan: true,
  });

  await catalogue.listExecutions();
  rejectDirectDatabaseWrites();

  const result = await scanInstrumentedObservedScope(workflow, {
    directory: "/observed/RJ01668691",
    executionId: "instrumented-explicit-work-plan",
    acceptTrusted: true,
    informationRequirement: {
      ...recognitionInformationRequirement(),
      artifactRoles: [],
    },
  });

  expect(result.execution.outcome).toBe("accepted");
  expect(result.execution.workItems).toEqual([
    expect.objectContaining({ outcome: "accepted" }),
  ]);
  catalogue.close();
});

it("does not precommit a trusted explicit-work-plan proposal when acceptance rolls back", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const workflow = instrumentedRecognitionWorkflow(catalogue, {
    explicitWorkPlan: true,
  });

  await catalogue.listExecutions();
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    database.exec(
      "CREATE TRIGGER reject_explicit_plan_artifacts BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'planned explicit-plan acceptance failure'); END",
    );
  } finally {
    database.close();
  }

  const result = await scanInstrumentedObservedScope(workflow, {
    directory: "/observed/RJ01668691",
    executionId: "instrumented-explicit-work-plan-rollback",
    acceptTrusted: true,
    informationRequirement: {
      ...recognitionInformationRequirement(),
      artifactRoles: [],
    },
  });

  expect(result.execution.outcome).not.toBe("accepted");
  const inspection = await catalogue.inspectExecution(
    "instrumented-explicit-work-plan-rollback",
  );
  expect(inspection?.proposal).toBeUndefined();
  expect(adoptionFactCounts(root)).toEqual(emptyAdoptionFactCounts());
  catalogue.close();
});

it("keeps a manual awaiting-confirmation proposal checkpoint through reopen using Drizzle", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const proposal = acceptedRecognition().proposal;

  await catalogue.listExecutions();
  await catalogue.createExecution(runningExecution());
  await retainSourceRecords(catalogue, "dlsite-execution", [sourceRecord()]);
  rejectDirectDatabaseWrites();

  await catalogue.finishExecutionWithProposal(
    runningExecution(),
    {
      ...runningExecution(),
      status: "completed",
      stage: "completed",
      outcome: "proposal",
      proposalId: proposal.id,
    },
    proposal,
  );
  catalogue.close();
  vi.restoreAllMocks();

  const reopened = SqliteCatalogue.forProductData(root);
  const inspection = await reopened.inspectExecution("dlsite-execution");
  expect(inspection?.execution).toMatchObject({
    status: "completed",
    outcome: "proposal",
    proposalId: proposal.id,
  });
  expect(inspection?.proposal).toEqual(proposal);
  reopened.close();
});

it("keeps a terminal Change Impact Preview checkpoint inside Drizzle without direct queries", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const running = {
    ...runningExecution(),
    id: "drizzle-change-preview-execution",
  };
  const proposal = {
    ...acceptedRecognition().proposal,
    id: "drizzle-change-preview-proposal",
  };
  const preview = {
    id: "drizzle-change-preview",
    executionId: running.id,
    assetId: "dlsite-work",
    proposal,
    baselines: [],
    current: {
      sourceAssociation: {
        sourceIdentity: "dlsite",
        nativeAddress:
          "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
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
      sourceAssociation: {
        sourceIdentity: "dlsite",
        nativeAddress: "https://www.dlsite.com/maniax/work/projected",
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

  await catalogue.listExecutions();
  await catalogue.createExecution(running);
  await retainSourceRecords(catalogue, running.id, [sourceRecord()]);
  const expectedExecution = (await catalogue.inspectExecution(running.id))
    ?.execution;
  if (expectedExecution === undefined)
    throw new Error("missing durable Change Impact Preview baseline");
  rejectDirectDatabaseQueries();

  await expect(
    catalogue.finishExecutionWithChangeImpactPreview({
      expectedExecution,
      execution: finished,
      proposal,
      preview,
    }),
  ).resolves.toBeUndefined();
  await expect(
    catalogue.inspectChangeImpactPreview(preview.id),
  ).resolves.toEqual(preview);
  catalogue.close();
});

it("reuses the accepted DLsite-shaped result on a guarded second scan without semantic duplicates", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const workflow = instrumentedRecognitionWorkflow(catalogue);
  const input = {
    directory: "/observed/RJ01668691",
    acceptTrusted: true,
    informationRequirement: recognitionInformationRequirement(),
  };

  await catalogue.listExecutions();
  const first = await scanInstrumentedObservedScope(workflow, {
    ...input,
    executionId: "instrumented-reuse-initial",
  });
  expect(first.execution.outcome).toBe("accepted");
  const factsBefore = adoptionFactCounts(root);
  const executionsBefore = executionAndSourceRecordCounts(root);

  rejectDirectDatabaseWrites();
  const second = await scanInstrumentedObservedScope(workflow, {
    ...input,
    executionId: "instrumented-reuse-second",
  });

  expect(second.execution).toMatchObject({
    outcome: "no-change",
    acceptedAssetId: first.accepted?.entity.id,
    reusedExecutionId: first.execution.id,
  });
  expect(adoptionFactCounts(root)).toEqual(factsBefore);
  expect(executionAndSourceRecordCounts(root)).toEqual({
    executions: executionsBefore.executions + 1,
    sourceRecords: executionsBefore.sourceRecords,
  });
  catalogue.close();
});

it("reevaluates a changed ordinary DLsite evidence-array observation without rewriting recognition identity", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const observation = { version: 1 };
  const workflow = instrumentedRecognitionWorkflow(catalogue, {
    observation,
    useExactDlsiteDirectory: true,
  });
  const input = {
    directory: "/observed/RJ01668691",
    acceptTrusted: true,
    informationRequirement: recognitionInformationRequirement(),
  };

  await catalogue.listExecutions();
  const first = await scanInstrumentedObservedScope(workflow, {
    ...input,
    executionId: "instrumented-observation-v1",
  });
  expect(first.execution.outcome).toBe("accepted");
  const initialFacts = adoptionFactCounts(root);
  const initialExecutions = executionAndSourceRecordCounts(root);
  const initialIdentity = recognitionIdentityFacts(root);
  const initialCoverFacts = primaryCoverFacts(root);
  expect(initialCoverFacts).toHaveLength(1);
  const originalReevaluation =
    catalogue.refreshAcceptedRecognition.bind(catalogue);
  let expectedReevaluation: WorkflowExecution | undefined;
  let durableReevaluation: WorkflowExecution | undefined;
  (
    catalogue as unknown as {
      refreshAcceptedRecognition(
        input: Parameters<SqliteCatalogue["refreshAcceptedRecognition"]>[0],
      ): Promise<void>;
    }
  ).refreshAcceptedRecognition = async (input) => {
    expectedReevaluation = input.expectedExecution;
    durableReevaluation = (await catalogue.inspectExecution(input.execution.id))
      ?.execution;
    await originalReevaluation(input);
  };

  // 路径、已接受来源身份/地址、来源载荷和托管字节保持稳定。只有新的文件观察更改其
  // 不透明观察版本和修改时间，因此不符合普通复用条件。
  observation.version = 2;
  rejectDirectDatabaseWrites();
  const second = await scanInstrumentedObservedScope(workflow, {
    ...input,
    executionId: "instrumented-observation-v2",
  });

  expect(second.execution).toMatchObject({
    outcome: "accepted",
    acceptedAssetId: first.accepted?.entity.id,
  });
  expect(second.accepted?.entity.id).toBe(first.accepted?.entity.id);
  expect(expectedReevaluation).toBeDefined();
  expect(durableReevaluation).toEqual(expectedReevaluation);
  expect(executionAndSourceRecordCounts(root)).toEqual({
    executions: initialExecutions.executions + 1,
    sourceRecords: initialExecutions.sourceRecords + 1,
  });
  expect(recognitionIdentityFacts(root)).toEqual(initialIdentity);

  const reevaluatedCoverFacts = primaryCoverFacts(root);
  expect(reevaluatedCoverFacts).toHaveLength(2);
  expect([
    ...new Set(reevaluatedCoverFacts.map((fact) => fact.artifactId)),
  ]).toHaveLength(2);
  expect([
    ...new Set(reevaluatedCoverFacts.map((fact) => fact.locationId)),
  ]).toHaveLength(2);
  expect([
    ...new Set(reevaluatedCoverFacts.map((fact) => fact.revisionId)),
  ]).toHaveLength(2);
  expect(new Set(reevaluatedCoverFacts.map((fact) => fact.blobDigest))).toEqual(
    new Set([initialCoverFacts[0]?.blobDigest]),
  );
  expect(adoptionFactCounts(root)).toMatchObject({
    artifacts: initialFacts.artifacts + 2,
    locations: initialFacts.locations + 2,
    artifactRevisions: initialFacts.artifactRevisions + 1,
    artifactAssociations: initialFacts.artifactAssociations + 2,
    blobs: initialFacts.blobs,
  });

  const factsAfterReevaluation = adoptionFactCounts(root);
  const executionsAfterReevaluation = executionAndSourceRecordCounts(root);
  const third = await scanInstrumentedObservedScope(workflow, {
    ...input,
    executionId: "instrumented-observation-v2-repeat",
  });

  expect(third.execution).toMatchObject({
    outcome: "no-change",
    acceptedAssetId: first.accepted?.entity.id,
  });
  expect(adoptionFactCounts(root)).toEqual(factsAfterReevaluation);
  expect(executionAndSourceRecordCounts(root)).toEqual({
    executions: executionsAfterReevaluation.executions + 1,
    sourceRecords: executionsAfterReevaluation.sourceRecords,
  });
  catalogue.close();
});

it("does not merge two source identities merely because their accepted titles match", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  await catalogue.listExecutions();
  const sameTitle = "A title is not an identity key";
  const requirement = recognitionInformationRequirement();

  const first = await scanInstrumentedObservedScope(
    instrumentedRecognitionWorkflow(catalogue, {
      identity: {
        key: "same-title-a",
        sourceIdentity: "catalogue-a",
        sourceAddress: "opaque:catalogue-a/work-1",
        title: sameTitle,
      },
    }),
    {
      directory: "/observed/same-title-a",
      executionId: "same-title-a-execution",
      acceptTrusted: true,
      informationRequirement: requirement,
    },
  );
  const second = await scanInstrumentedObservedScope(
    instrumentedRecognitionWorkflow(catalogue, {
      identity: {
        key: "same-title-b",
        sourceIdentity: "catalogue-b",
        sourceAddress: "opaque:catalogue-b/work-2",
        title: sameTitle,
      },
    }),
    {
      directory: "/observed/same-title-b",
      executionId: "same-title-b-execution",
      acceptTrusted: true,
      informationRequirement: requirement,
    },
  );

  expect(first.execution.outcome).toBe("accepted");
  expect(second.execution.outcome).toBe("accepted");
  expect(second.accepted?.entity.id).not.toBe(first.accepted?.entity.id);

  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM entities WHERE kind = 'digital-asset'",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      database
        .prepare(
          `SELECT source_identity, native_address
           FROM source_associations
           ORDER BY source_identity`,
        )
        .all(),
    ).toEqual([
      {
        source_identity: "catalogue-a",
        native_address: "opaque:catalogue-a/work-1",
      },
      {
        source_identity: "catalogue-b",
        native_address: "opaque:catalogue-b/work-2",
      },
    ]);
  } finally {
    database.close();
  }
  catalogue.close();
});

it("rejects a stale acceptance baseline before any Drizzle domain fact write", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const stale = { ...runningExecution(), id: "stale-dlsite-execution" };

  await catalogue.listExecutions();
  await catalogue.createExecution(stale);
  await catalogue.finishExecution(stale, {
    ...stale,
    status: "completed",
    stage: "completed",
    outcome: "unresolved",
  });
  rejectDirectDatabaseWrites();

  await expect(
    acceptRecognition(catalogue, {
      execution: { ...acceptedExecution(), id: stale.id },
      accepted: acceptedRecognition(),
    }),
  ).rejects.toThrow("execution baseline is stale");

  expect(adoptionFactCounts(root)).toEqual(emptyAdoptionFactCounts());
  catalogue.close();
});

it("rejects a changed running execution audit baseline before accepting any facts", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);

  await catalogue.listExecutions();
  await catalogue.createExecution(runningExecution());
  await retainSourceRecords(catalogue, "dlsite-execution", [sourceRecord()]);
  const expected = (await catalogue.inspectExecution("dlsite-execution"))!
    .execution;
  const concurrent: WorkflowExecution = {
    ...expected,
    stage: "recognition",
    reason: "concurrent checkpoint",
    proposalId: "concurrent-proposal",
    sourceRecordIds: [...expected.sourceRecordIds, "concurrent-record"],
    workItems: [
      {
        key: "concurrent-work-item",
        relativePaths: ["concurrent.wav"],
        sourceRecordIds: ["concurrent-record"],
        reason: "concurrent work-item checkpoint",
      },
    ],
  };
  await catalogue.transitionExecution(expected, concurrent);
  const accepted = acceptedRecognition();
  rejectDirectDatabaseWrites();

  await expect(
    catalogue.acceptRecognition({
      expectedExecution: expected,
      execution: {
        ...expected,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        proposalId: accepted.proposal.id,
        acceptedAssetId: accepted.entity.id,
      },
      accepted,
    }),
  ).rejects.toThrow("execution baseline is stale");

  expect(adoptionFactCounts(root)).toEqual(emptyAdoptionFactCounts());
  expect((await catalogue.inspectExecution(expected.id))?.execution).toEqual(
    concurrent,
  );
  catalogue.close();
});

it("rejects an invalid AcceptedRecognition before the SQLite transaction writes anything", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);

  await catalogue.listExecutions();
  await catalogue.createExecution(runningExecution());
  await retainSourceRecords(catalogue, "dlsite-execution", [sourceRecord()]);
  const expected = (await catalogue.inspectExecution("dlsite-execution"))!
    .execution;
  const auditBefore = executionAuditJson(root, expected.id);
  const accepted = acceptedRecognition();
  const invalid: AcceptedRecognition = {
    ...accepted,
    recognitionSourceAssociation: {
      ...accepted.recognitionSourceAssociation,
      proposalId: "different-proposal",
    },
    sourceAssociations: [
      {
        ...accepted.recognitionSourceAssociation!,
        proposalId: "different-proposal",
      },
    ],
  };
  rejectDirectDatabaseWrites();

  await expect(
    catalogue.acceptRecognition({
      expectedExecution: expected,
      execution: {
        ...expected,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        proposalId: accepted.proposal.id,
        acceptedAssetId: accepted.entity.id,
      },
      accepted: invalid,
    }),
  ).rejects.toThrow(
    "Source Association must reference the accepted Recognition Proposal",
  );

  expect(executionAuditJson(root, expected.id)).toBe(auditBefore);
  expect(adoptionFactCounts(root)).toEqual(emptyAdoptionFactCounts());
  catalogue.close();
});

it("retains a Source Record idempotently only for its exact canonical owner payload", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const owner = {
    ...runningExecution(),
    id: "source-record-canonical-owner",
    sourceRecordIds: [],
  };
  const record = sourceRecord("source-record-canonical");

  await catalogue.listExecutions();
  await catalogue.createExecution(owner);
  await retainSourceRecords(catalogue, owner.id, [record]);
  const auditBeforeReplay = executionAuditJson(root, owner.id);

  await expect(
    retainSourceRecords(catalogue, owner.id, [{ ...record }]),
  ).resolves.toBeUndefined();
  expect(executionAuditJson(root, owner.id)).toBe(auditBeforeReplay);
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    expect(
      database
        .prepare(
          `SELECT execution_id, digest, body
           FROM source_records WHERE id = ?`,
        )
        .get(record.id),
    ).toEqual({
      execution_id: owner.id,
      digest: record.digest,
      body: record.body,
    });
  } finally {
    database.close();
  }
  catalogue.close();
});

it("rejects a Source Record ID claimed by a different execution without changing its audit", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const owner = {
    ...runningExecution(),
    id: "source-record-first-owner",
    sourceRecordIds: [],
  };
  const other = {
    ...runningExecution(),
    id: "source-record-second-owner",
    sourceRecordIds: [],
  };
  const record = sourceRecord("source-record-owned-once");

  await catalogue.listExecutions();
  await catalogue.createExecution(owner);
  await catalogue.createExecution(other);
  await retainSourceRecords(catalogue, owner.id, [record]);
  const otherAudit = executionAuditJson(root, other.id);
  const otherBeforeConflict = (await catalogue.inspectExecution(other.id))!
    .execution;

  await expect(
    retainSourceRecords(catalogue, other.id, [record]),
  ).rejects.toThrow(
    "Source Record source-record-owned-once conflicts with durable history",
  );

  expect(executionAuditJson(root, other.id)).toBe(otherAudit);
  expect((await catalogue.inspectExecution(other.id))?.execution).toEqual(
    otherBeforeConflict,
  );
  catalogue.close();
});

it("rejects a changed Source Record payload or provenance without changing its audit", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const owner = {
    ...runningExecution(),
    id: "source-record-payload-owner",
    sourceRecordIds: [],
  };
  const record = sourceRecord("source-record-immutable");

  await catalogue.listExecutions();
  await catalogue.createExecution(owner);
  await retainSourceRecords(catalogue, owner.id, [record]);
  const auditBeforeConflict = executionAuditJson(root, owner.id);
  const ownerBeforeConflict = (await catalogue.inspectExecution(owner.id))!
    .execution;

  await expect(
    retainSourceRecords(catalogue, owner.id, [
      { ...record, body: '{"changed":true}' },
    ]),
  ).rejects.toThrow(
    "Source Record source-record-immutable conflicts with durable history",
  );
  await expect(
    retainSourceRecords(catalogue, owner.id, [
      {
        ...record,
        acquisition: { ...record.acquisition, authorized: true },
      },
    ]),
  ).rejects.toThrow(
    "Source Record source-record-immutable conflicts with durable history",
  );

  expect(executionAuditJson(root, owner.id)).toBe(auditBeforeConflict);
  expect((await catalogue.inspectExecution(owner.id))?.execution).toEqual(
    ownerBeforeConflict,
  );
  catalogue.close();
});

it("rejects foreign Source Records from proposal interpretation and recognition evidence", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const owner = {
    ...runningExecution(),
    id: "proposal-owner",
    sourceRecordIds: [],
  };
  const foreignOwner = {
    ...runningExecution(),
    id: "proposal-foreign-owner",
    sourceRecordIds: [],
  };
  const ownedRecord = sourceRecord("proposal-owned-record");
  const foreignRecord = sourceRecord("proposal-foreign-record");

  await catalogue.listExecutions();
  await catalogue.createExecution(owner);
  await catalogue.createExecution(foreignOwner);
  await retainSourceRecords(catalogue, owner.id, [ownedRecord]);
  await retainSourceRecords(catalogue, foreignOwner.id, [foreignRecord]);
  const current = (await catalogue.inspectExecution(owner.id))!.execution;
  const auditBefore = executionAuditJson(root, owner.id);
  const base = acceptedRecognition().proposal;
  const interpretationForeign = {
    ...base,
    id: "proposal-foreign-interpretation",
    basis: {
      ...base.basis,
      interpretation: {
        ...base.basis.interpretation,
        id: "proposal-foreign-interpretation-batch",
        sourceRecordIds: [foreignRecord.id],
      },
    },
  };

  await expect(
    catalogue.finishExecutionWithProposal(
      current,
      {
        ...current,
        status: "completed",
        stage: "completed",
        outcome: "proposal",
        proposalId: interpretationForeign.id,
      },
      interpretationForeign,
    ),
  ).rejects.toThrow(
    "Recognition Proposal references Source Record outside its execution",
  );
  expect(executionAuditJson(root, owner.id)).toBe(auditBefore);
  expect(
    (await catalogue.inspectExecution(owner.id))?.proposal,
  ).toBeUndefined();

  const evidenceReferences = [
    { kind: "source-record" as const, sourceRecordId: foreignRecord.id },
  ];
  const evidenceForeign = {
    ...base,
    id: "proposal-foreign-evidence",
    basis: {
      ...base.basis,
      interpretation: {
        ...base.basis.interpretation,
        id: "proposal-foreign-evidence-batch",
        sourceRecordIds: [ownedRecord.id, foreignRecord.id],
        recognitionEvidenceReferences: evidenceReferences,
      },
    },
    ruleResults: base.ruleResults.map((result) => ({
      ...result,
      evidenceReferences,
    })),
  };
  await expect(
    catalogue.finishExecutionWithProposal(
      current,
      {
        ...current,
        status: "completed",
        stage: "completed",
        outcome: "proposal",
        proposalId: evidenceForeign.id,
      },
      evidenceForeign,
    ),
  ).rejects.toThrow(
    "Recognition Proposal references Source Record outside its execution",
  );
  expect(executionAuditJson(root, owner.id)).toBe(auditBefore);
  expect(
    (await catalogue.inspectExecution(owner.id))?.proposal,
  ).toBeUndefined();
  catalogue.close();
});

it("rolls back identity and Artifact continuity conflicts despite equal title, path, and Blob", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const conflictExecution: WorkflowExecution = {
    ...runningExecution(),
    id: "dlsite-continuity-conflict",
    sourceRecordIds: ["dlsite-continuity-record"],
  };

  await catalogue.listExecutions();
  rejectDirectDatabaseWrites();
  await catalogue.createExecution(runningExecution());
  await retainSourceRecords(catalogue, "dlsite-execution", [sourceRecord()]);
  await acceptRecognition(catalogue, {
    execution: acceptedExecution(),
    accepted: acceptedRecognition(),
  });
  const factsBefore = adoptionFactCounts(root);
  await catalogue.createExecution(conflictExecution);
  await retainSourceRecords(catalogue, conflictExecution.id, [
    sourceRecord("dlsite-continuity-record"),
  ]);

  await expect(
    acceptRecognition(catalogue, {
      execution: {
        ...conflictExecution,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        proposalId: "dlsite-continuity-proposal",
        acceptedAssetId: "dlsite-continuity-work",
      },
      accepted: continuityConflictRecognition(),
    }),
  ).rejects.toThrow(
    "Stable Artifact Association dlsite-cover-association conflicts with durable history",
  );

  expect(adoptionFactCounts(root)).toEqual(factsBefore);
  const inspection = await catalogue.inspectExecution(conflictExecution.id);
  expect(inspection?.execution.status).toBe("running");
  expect(inspection?.proposal).toBeUndefined();
  expect(inspection?.accepted).toBeUndefined();
  catalogue.close();
});

it("keeps equal title, managed path, and Blob as independent identity facts", async () => {
  const root = await preparedCatalogueRoot();
  cleanup.push(root);
  const catalogue = SqliteCatalogue.forProductData(root);
  const independentExecution: WorkflowExecution = {
    ...runningExecution(),
    id: "dlsite-independent-execution",
    sourceRecordIds: ["dlsite-independent-record"],
  };

  await catalogue.listExecutions();
  rejectDirectDatabaseWrites();
  await catalogue.createExecution(runningExecution());
  await retainSourceRecords(catalogue, "dlsite-execution", [sourceRecord()]);
  await acceptRecognition(catalogue, {
    execution: acceptedExecution(),
    accepted: acceptedRecognition(),
  });
  await catalogue.createExecution(independentExecution);
  await retainSourceRecords(catalogue, independentExecution.id, [
    sourceRecord(
      "dlsite-independent-record",
      "https://www.dlsite.com/maniax/work/=/product_id/RJ01234567.html",
    ),
  ]);

  await expect(
    acceptRecognition(catalogue, {
      execution: {
        ...independentExecution,
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        proposalId: "dlsite-independent-proposal",
        acceptedAssetId: "dlsite-independent-work",
      },
      accepted: independentlyAcceptedRecognition(),
    }),
  ).resolves.toBeUndefined();

  expect(adoptionFactCounts(root)).toMatchObject({
    artifacts: 2,
    artifactAssociations: 2,
    artifactRevisions: 2,
    blobs: 1,
    currentSourceArtifactCandidateLineages: 2,
    currentSourceAssociations: 2,
    // 两个数字资产，加上第一部作品独立获取的演职员事实。
    entities: 3,
    locations: 2,
    metadataAssertions: 2,
    recognitionDecisions: 2,
    recognitionProposals: 2,
    recognitionHeads: 2,
    sourceAssociations: 2,
    sourceLineageHeads: 2,
  });
  catalogue.close();
});

function adoptionFactCounts(root: string) {
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    return database
      .prepare(
        `SELECT
          (SELECT count(*) FROM recognition_proposals) AS recognitionProposals,
          (SELECT count(*) FROM entities) AS entities,
          (SELECT count(*) FROM sourced_entities) AS sourcedEntities,
          (SELECT count(*) FROM source_associations) AS sourceAssociations,
          (SELECT count(*) FROM recognition_decisions) AS recognitionDecisions,
          (SELECT count(*) FROM recognition_heads) AS recognitionHeads,
          (SELECT count(*) FROM current_source_associations) AS currentSourceAssociations,
          (SELECT count(*) FROM source_lineage_heads) AS sourceLineageHeads,
          (SELECT count(*) FROM current_source_artifact_candidate_lineages) AS currentSourceArtifactCandidateLineages,
          (SELECT count(*) FROM artifacts) AS artifacts,
          (SELECT count(*) FROM locations) AS locations,
          (SELECT count(*) FROM blobs) AS blobs,
          (SELECT count(*) FROM artifact_revisions) AS artifactRevisions,
          (SELECT count(*) FROM artifact_associations) AS artifactAssociations,
          (SELECT count(*) FROM metadata_assertions) AS metadataAssertions,
          (SELECT count(*) FROM metadata_assertion_sources) AS metadataAssertionSources,
          (SELECT count(*) FROM metadata_assertion_lifecycles) AS metadataAssertionLifecycles,
          (SELECT count(*) FROM entity_relationships) AS entityRelationships,
          (SELECT count(*) FROM relationship_sources) AS relationshipSources,
          (SELECT count(*) FROM relationship_lifecycles) AS relationshipLifecycles,
          (SELECT count(*) FROM entity_mentions) AS entityMentions,
          (SELECT count(*) FROM entity_resolution_decisions) AS entityResolutionDecisions,
          (SELECT count(*) FROM metadata_policy_enrollments) AS metadataPolicyEnrollments`,
      )
      .get();
  } finally {
    database.close();
  }
}

function sourceScopeSnapshot(
  root: string,
  input: {
    readonly subjectId: string;
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
    readonly coverageId: string;
  },
) {
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    const head = database
      .prepare(
        `SELECT source_record_id FROM source_lineage_heads
         WHERE subject_id = ? AND source_identity = ? AND native_address = ?
           AND coverage_id = ?`,
      )
      .get(
        input.subjectId,
        input.sourceIdentity,
        input.nativeAddress,
        input.coverageId,
      ) as { readonly source_record_id: string } | undefined;
    const currentMetadata = database
      .prepare(
        `SELECT a.property, a.value, l.source_slot, l.source_record_id
         FROM metadata_assertion_lifecycles l
         JOIN metadata_assertions a ON a.id = l.assertion_id
         WHERE a.subject_id = ? AND l.source_identity = ?
           AND l.native_address = ? AND l.coverage_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM metadata_assertion_retractions retraction
             WHERE retraction.assertion_id = l.assertion_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM metadata_assertion_lifecycles successor
             WHERE successor.predecessor_assertion_id = l.assertion_id
           )
         ORDER BY l.source_slot, a.value`,
      )
      .all(
        input.subjectId,
        input.sourceIdentity,
        input.nativeAddress,
        input.coverageId,
      );
    return {
      head: head?.source_record_id,
      currentMetadata,
    };
  } finally {
    database.close();
  }
}

function emptyAdoptionFactCounts() {
  return {
    artifactAssociations: 0,
    artifactRevisions: 0,
    artifacts: 0,
    blobs: 0,
    currentSourceArtifactCandidateLineages: 0,
    currentSourceAssociations: 0,
    entities: 0,
    entityMentions: 0,
    entityRelationships: 0,
    entityResolutionDecisions: 0,
    locations: 0,
    metadataAssertionLifecycles: 0,
    metadataAssertionSources: 0,
    metadataAssertions: 0,
    metadataPolicyEnrollments: 0,
    recognitionDecisions: 0,
    recognitionProposals: 0,
    relationshipLifecycles: 0,
    relationshipSources: 0,
    recognitionHeads: 0,
    sourceAssociations: 0,
    sourceLineageHeads: 0,
    sourcedEntities: 0,
  };
}

function executionAndSourceRecordCounts(root: string) {
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    return database
      .prepare(
        `SELECT
          (SELECT count(*) FROM workflow_executions) AS executions,
          (SELECT count(*) FROM source_records) AS sourceRecords`,
      )
      .get();
  } finally {
    database.close();
  }
}

function recognitionIdentityFacts(root: string) {
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    return {
      associations: database
        .prepare(
          `SELECT id, subject_id, source_identity, native_address, proposal_id
           FROM source_associations
           ORDER BY id`,
        )
        .all(),
      decisions: database
        .prepare(
          `SELECT id, proposal_id, asset_id, accepted_rule_results_json
           FROM recognition_decisions
           ORDER BY id`,
        )
        .all(),
      heads: database
        .prepare(
          `SELECT subject_id, recognition_source_association_id, recognition_decision_id
           FROM recognition_heads
           ORDER BY subject_id`,
        )
        .all(),
    };
  } finally {
    database.close();
  }
}

function primaryCoverFacts(root: string) {
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    return database
      .prepare(
        `SELECT
           association.id AS associationId,
           association.artifact_id AS artifactId,
           location.id AS locationId,
           revision.id AS revisionId,
           revision.blob_digest AS blobDigest
         FROM artifact_associations association
         JOIN locations location ON location.artifact_id = association.artifact_id
         JOIN artifact_revisions revision ON revision.artifact_id = association.artifact_id
         WHERE association.role = 'asset.primary-cover'
         ORDER BY association.id`,
      )
      .all() as readonly {
      readonly associationId: string;
      readonly artifactId: string;
      readonly locationId: string;
      readonly revisionId: string;
      readonly blobDigest: string;
    }[];
  } finally {
    database.close();
  }
}

function executionAuditJson(root: string, executionId: string): string {
  const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
  try {
    const row = database
      .prepare("SELECT audit_json FROM workflow_executions WHERE id = ?")
      .get(executionId) as { readonly audit_json: string } | undefined;
    if (row === undefined) throw new Error(`Unknown execution ${executionId}`);
    return row.audit_json;
  } finally {
    database.close();
  }
}

function recognitionInformationRequirement() {
  return {
    metadataUsageContext: "asset.ordinary" as const,
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
}

function instrumentedRecognitionWorkflow(
  catalogue: SqliteCatalogue,
  options?: {
    readonly explicitWorkPlan?: boolean;
    /** 可变测试观察状态；更改它可模拟全新扫描。 */
    readonly observation?: { version: number };
    /** 验证随产品交付的非显式 DLsite 证据数组解释器。 */
    readonly useExactDlsiteDirectory?: boolean;
    /** 使用不同的持久来源身份验证身份边界。 */
    readonly identity?: {
      readonly key: string;
      readonly sourceIdentity: string;
      readonly sourceAddress: string;
      readonly title: string;
    };
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
) {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const identity = options?.identity ?? {
    key: "dlsite",
    sourceIdentity: "dlsite",
    sourceAddress:
      "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
    title: "Instrumented DLsite work",
  };
  const observationSuffix = () =>
    options?.observation === undefined
      ? ""
      : `-v${options.observation.version}`;
  const recordId = () =>
    `instrumented-${identity.key}-record${observationSuffix()}`;
  const observationTime = () =>
    options?.observation === undefined
      ? "2026-08-02T00:00:00.000Z"
      : `2026-08-02T00:00:0${options.observation.version}.000Z`;
  const coverAddress =
    identity.key === "dlsite"
      ? "https://www.dlsite.com/maniax/img/work/RJ01668691.jpg"
      : `https://source.example/${identity.key}.jpg`;
  const capability = (capabilityId: string) => ({
    capabilityId,
    capabilityVersion: "1",
    contractVersion: "1",
  });
  const observedRootRegistrations =
    options?.observedRootRegistrations ??
    instrumentedObservedRootRegistrations({
      capability: capability("dlsite.observer"),
      async observe({ scope }) {
        return {
          id: `instrumented-${identity.key}-snapshot${observationSuffix()}`,
          root: scope.logicalLocation,
          complete: true,
          excluded: [],
          files:
            options?.explicitWorkPlan === true ||
            options?.observation !== undefined
              ? [
                  {
                    relativePath: "instrumented-dlsite.wav",
                    size: 4,
                    modifiedAt: observationTime(),
                  },
                ]
              : [],
          observedAt: observationTime(),
        };
      },
    });
  return new AssetRefreshWorkflow({
    observedRootRegistrations,
    directoryInterpreters:
      options?.useExactDlsiteDirectory === true
        ? [new DlsiteExactDirectoryInterpreter()]
        : [
            {
              capability: capability("dlsite.directory"),
              interpret: () => {
                const evidence = {
                  kind: "source-address" as const,
                  sourceIdentity: identity.sourceIdentity,
                  sourceAddress: identity.sourceAddress,
                  explanation: "exact DLsite directory evidence",
                  producer: capability("dlsite.directory"),
                };
                return options?.explicitWorkPlan === true
                  ? {
                      workItems: [
                        {
                          key: "instrumented-dlsite-work-item",
                          relativePaths: ["instrumented-dlsite.wav"],
                          evidence: [evidence],
                        },
                      ],
                    }
                  : [evidence];
              },
            },
          ],
    collectors: [
      {
        capability: capability("dlsite.collector"),
        canCollect: (evidence) =>
          evidence.sourceIdentity === identity.sourceIdentity,
        coverageScopeIds: () => ["dlsite.product"],
        async collect() {
          const sourceRecordId = recordId();
          return {
            failures: [],
            records: [
              {
                id: sourceRecordId,
                sourceIdentity: identity.sourceIdentity,
                nativeAddress: identity.sourceAddress,
                mediaType: "application/json",
                acquiredAt: observationTime(),
                acquisition: {
                  requestedAddress:
                    identity.key === "dlsite"
                      ? "https://www.dlsite.com/maniax/api/=/product_id/RJ01668691.json"
                      : `https://source.example/${identity.key}.json`,
                  method: "GET" as const,
                  authorized: false,
                },
                coverage: {
                  id: "dlsite.product",
                  completeness: "complete" as const,
                  authority: "official" as const,
                },
                // 来源载荷在各次扫描间逐字节相同；每次观察仍各自拥有新的来源记录。
                digest: `instrumented-${identity.key}-record-digest`,
                body: "{}",
              },
            ],
          };
        },
      },
    ],
    sourceInterpreters: [
      {
        capability: capability("dlsite.interpreter"),
        canInterpret: ({ sourceRecords }) => sourceRecords.length === 1,
        interpret: () => {
          const sourceRecordId = recordId();
          return {
            id: `instrumented-${identity.key}-interpretation${observationSuffix()}`,
            producer: capability("dlsite.interpreter"),
            sourceRecordIds: [sourceRecordId],
            sourceIdentity: identity.sourceIdentity,
            sourceAddress: identity.sourceAddress,
            metadata: [
              {
                property: "asset.title",
                sourceSlot: "dlsite.title",
                value: identity.title,
                sourceRecordIds: [sourceRecordId],
              },
            ],
            sourceArtifacts: [
              {
                id: `instrumented-${identity.key}-cover-candidate${observationSuffix()}`,
                sourceRecordId,
                role: "asset.primary-cover",
                acquisitionReference: coverAddress,
                mediaType: "image/jpeg",
              },
            ],
          };
        },
      },
    ],
    recognizers: [
      {
        capability: capability("dlsite.recognizer"),
        canRecognize: () => true,
        recognize: ({ evidence }) => ({
          id: `instrumented-${identity.key}-proposal${observationSuffix()}`,
          ruleResults: [
            {
              capabilityId: "dlsite.recognizer",
              capabilityVersion: "1",
              ruleId: "exact-dlsite-address",
              ruleVersion: "1",
              outcome: "satisfied" as const,
              explanation: "exact DLsite source address",
              evidence,
            },
          ],
        }),
      },
    ],
    recognitionPolicy: {
      version: "instrumented-dlsite-policy/1",
      accepts: (result) => result.ruleId === "exact-dlsite-address",
    },
    acquirers: [
      {
        capability: capability("dlsite.acquirer"),
        canAcquire: () => true,
        async acquire(candidate) {
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
      async store(content) {
        return {
          blob: {
            digest: sha256(content.bytes),
            mediaType: content.mediaType,
            byteLength: content.bytes.byteLength,
          },
          location: { address: `/managed/instrumented-${identity.key}-cover` },
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
    changeImpactQueries: catalogue,
    changeImpactCommands: catalogue,
  });
}

function rejectDirectDatabaseWrites(): void {
  const prepare = DatabaseSync.prototype.prepare;
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    source: string,
  ) {
    return compileWithDirectWriteAuthorizer(this, source, () =>
      prepare.call(this, source),
    );
  });
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    source: string,
  ) {
    return compileWithDirectWriteAuthorizer(this, source, () =>
      exec.call(this, source),
    );
  });
}

/**
 * 持久化端口只能通过 Drizzle 使用原生 SQLite 驱动。这里刻意同时守卫读取和写入：
 * 授权器可以证明后者，但手动准备的 `SELECT` 否则可能在重现旧查询路径时保持不可见。
 */
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

/**
 * 预检必须在第一条 `INSERT`/`UPDATE`/`DELETE` 前拒绝输入，包括 Drizzle 生成的语句。
 * 事务本身仍获准，使守卫在语句层观察持久化边界，而不是在预检运行前拒绝
 * `BEGIN IMMEDIATE`。
 */
function rejectAllMetadataRefreshDml(): void {
  const prepare = DatabaseSync.prototype.prepare;
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    source: string,
  ) {
    return compileWithNoMetadataRefreshDml(this, source, () =>
      prepare.call(this, source),
    );
  });
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    source: string,
  ) {
    return compileWithNoMetadataRefreshDml(this, source, () =>
      exec.call(this, source),
    );
  });
}

type NoMetadataRefreshDmlAuthorizerState = {
  violation: string | undefined;
};

const noMetadataRefreshDmlAuthorizers = new WeakMap<
  DatabaseSync,
  NoMetadataRefreshDmlAuthorizerState
>();

function compileWithNoMetadataRefreshDml<T>(
  database: DatabaseSync,
  source: string,
  compile: () => T,
): T {
  const state = noMetadataRefreshDmlAuthorizerState(database);
  const previousViolation = state.violation;
  state.violation = undefined;
  try {
    return compile();
  } catch (error) {
    const violation = state.violation;
    if (violation !== undefined) {
      throw new Error(
        `Metadata Refresh preflight emitted ${String(violation)}: ${source}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    state.violation = previousViolation;
  }
}

function noMetadataRefreshDmlAuthorizerState(
  database: DatabaseSync,
): NoMetadataRefreshDmlAuthorizerState {
  const existing = noMetadataRefreshDmlAuthorizers.get(database);
  if (existing !== undefined) return existing;
  const state: NoMetadataRefreshDmlAuthorizerState = {
    violation: undefined,
  };
  database.setAuthorizer((actionCode) => {
    const action = directWriteActions.get(actionCode);
    if (
      action === "SQLITE_INSERT" ||
      action === "SQLITE_UPDATE" ||
      action === "SQLITE_DELETE"
    ) {
      state.violation = action;
      return sqliteConstants.SQLITE_DENY;
    }
    return sqliteConstants.SQLITE_OK;
  });
  noMetadataRefreshDmlAuthorizers.set(database, state);
  return state;
}

type DirectWriteCompilation = {
  readonly source: string;
  readonly firstNonTestFrame: string | undefined;
};

type DirectWriteViolation = {
  readonly action: string;
  readonly compilation: DirectWriteCompilation;
};

type DirectWriteAuthorizerState = {
  compilation: DirectWriteCompilation | undefined;
  violation: DirectWriteViolation | undefined;
};

const directWriteAuthorizers = new WeakMap<
  DatabaseSync,
  DirectWriteAuthorizerState
>();

/** SQLite 会在编译时报告这些动作码，与 SQL 文本无关。 */
const directWriteActions = new Map<number, string>([
  [sqliteConstants.SQLITE_INSERT, "SQLITE_INSERT"],
  [sqliteConstants.SQLITE_UPDATE, "SQLITE_UPDATE"],
  [sqliteConstants.SQLITE_DELETE, "SQLITE_DELETE"],
  [sqliteConstants.SQLITE_TRANSACTION, "SQLITE_TRANSACTION"],
  [sqliteConstants.SQLITE_SAVEPOINT, "SQLITE_SAVEPOINT"],
  [sqliteConstants.SQLITE_PRAGMA, "SQLITE_PRAGMA"],
  [sqliteConstants.SQLITE_ATTACH, "SQLITE_ATTACH"],
  [sqliteConstants.SQLITE_DETACH, "SQLITE_DETACH"],
  [sqliteConstants.SQLITE_REINDEX, "SQLITE_REINDEX"],
  [sqliteConstants.SQLITE_ANALYZE, "SQLITE_ANALYZE"],
  [sqliteConstants.SQLITE_CREATE_INDEX, "SQLITE_CREATE_INDEX"],
  [sqliteConstants.SQLITE_CREATE_TABLE, "SQLITE_CREATE_TABLE"],
  [sqliteConstants.SQLITE_CREATE_TEMP_INDEX, "SQLITE_CREATE_TEMP_INDEX"],
  [sqliteConstants.SQLITE_CREATE_TEMP_TABLE, "SQLITE_CREATE_TEMP_TABLE"],
  [sqliteConstants.SQLITE_CREATE_TEMP_TRIGGER, "SQLITE_CREATE_TEMP_TRIGGER"],
  [sqliteConstants.SQLITE_CREATE_TEMP_VIEW, "SQLITE_CREATE_TEMP_VIEW"],
  [sqliteConstants.SQLITE_CREATE_TRIGGER, "SQLITE_CREATE_TRIGGER"],
  [sqliteConstants.SQLITE_CREATE_VIEW, "SQLITE_CREATE_VIEW"],
  [sqliteConstants.SQLITE_CREATE_VTABLE, "SQLITE_CREATE_VTABLE"],
  [sqliteConstants.SQLITE_DROP_INDEX, "SQLITE_DROP_INDEX"],
  [sqliteConstants.SQLITE_DROP_TABLE, "SQLITE_DROP_TABLE"],
  [sqliteConstants.SQLITE_DROP_TEMP_INDEX, "SQLITE_DROP_TEMP_INDEX"],
  [sqliteConstants.SQLITE_DROP_TEMP_TABLE, "SQLITE_DROP_TEMP_TABLE"],
  [sqliteConstants.SQLITE_DROP_TEMP_TRIGGER, "SQLITE_DROP_TEMP_TRIGGER"],
  [sqliteConstants.SQLITE_DROP_TEMP_VIEW, "SQLITE_DROP_TEMP_VIEW"],
  [sqliteConstants.SQLITE_DROP_TRIGGER, "SQLITE_DROP_TRIGGER"],
  [sqliteConstants.SQLITE_DROP_VIEW, "SQLITE_DROP_VIEW"],
  [sqliteConstants.SQLITE_DROP_VTABLE, "SQLITE_DROP_VTABLE"],
  [sqliteConstants.SQLITE_ALTER_TABLE, "SQLITE_ALTER_TABLE"],
]);

function compileWithDirectWriteAuthorizer<T>(
  database: DatabaseSync,
  source: string,
  compile: () => T,
): T {
  const state = directWriteAuthorizerState(database);
  const previousCompilation = state.compilation;
  const previousViolation = state.violation;
  state.compilation = { source, firstNonTestFrame: firstNonTestFrame() };
  state.violation = undefined;
  try {
    return compile();
  } catch (error) {
    const violation = state.violation;
    if (violation !== undefined) {
      const origin =
        violation.compilation.firstNonTestFrame ?? "unknown caller";
      throw new Error(
        `raw DatabaseSync write escaped Drizzle (${violation.action}; ${origin}): ${violation.compilation.source}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    state.compilation = previousCompilation;
    state.violation = previousViolation;
  }
}

function directWriteAuthorizerState(
  database: DatabaseSync,
): DirectWriteAuthorizerState {
  const existing = directWriteAuthorizers.get(database);
  if (existing !== undefined) return existing;
  const state: DirectWriteAuthorizerState = {
    compilation: undefined,
    violation: undefined,
  };
  database.setAuthorizer((actionCode) => {
    const action = directWriteActions.get(actionCode);
    const compilation = state.compilation;
    if (
      action === undefined ||
      (compilation !== undefined &&
        firstNonTestFrameIsDrizzle(compilation.firstNonTestFrame))
    ) {
      return sqliteConstants.SQLITE_OK;
    }
    state.violation = {
      action,
      compilation: compilation ?? {
        source: "<unattributed prepared statement>",
        firstNonTestFrame: undefined,
      },
    };
    return sqliteConstants.SQLITE_DENY;
  });
  directWriteAuthorizers.set(database, state);
  return state;
}

function firstNonTestFrame(): string | undefined {
  return (new Error().stack ?? "")
    .split("\n")
    .slice(1)
    .find(
      (candidate) =>
        !candidate.includes("drizzle-recognition-adoption.test") &&
        !candidate.includes("node:internal") &&
        !candidate.includes("tinyspy") &&
        !candidate.includes("vitest"),
    );
}

function firstNonTestFrameIsDrizzle(frame: string | undefined): boolean {
  return frame !== undefined && /[/\\]drizzle-orm[/\\]/u.test(frame);
}

function runningExecution(): WorkflowExecution {
  return {
    id: "dlsite-execution",
    selection: { directory: "/observed/RJ01668691" },
    snapshot: {
      id: "dlsite-snapshot",
      root: "/observed/RJ01668691",
      complete: true,
      excluded: [],
      files: [],
      observedAt: "2026-08-02T00:00:00.000Z",
    },
    status: "running",
    stage: "source-artifacts-stored",
    sourceRecordIds: ["dlsite-record"],
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

function acceptedExecution(): WorkflowExecution {
  return {
    ...runningExecution(),
    status: "completed",
    stage: "completed",
    outcome: "accepted",
    proposalId: "dlsite-proposal",
    acceptedAssetId: "dlsite-work",
  };
}

function sourceRecord(
  id = "dlsite-record",
  nativeAddress = "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
) {
  return {
    id,
    sourceIdentity: "dlsite",
    nativeAddress,
    mediaType: "application/json",
    acquiredAt: "2026-08-02T00:00:00.000Z",
    acquisition: {
      requestedAddress:
        "https://www.dlsite.com/maniax/api/=/product_id/RJ01668691.json",
      method: "GET" as const,
      authorized: false,
    },
    coverage: {
      id: "dlsite.product-json",
      completeness: "complete" as const,
      authority: "official" as const,
    },
    digest: `${id}-digest`,
    body: "{}",
  };
}

type OmdbSourceResult = {
  readonly record: SourceRecord;
  readonly interpretation: SourceInterpretationBatch;
};

function withOmdbCoverage(
  source: OmdbSourceResult,
  coverageId: string,
  suffix: string,
): OmdbSourceResult {
  return withOmdbSourceCoordinate(source, { coverageId, suffix });
}

function withOmdbSourceCoordinate(
  source: OmdbSourceResult,
  input: {
    readonly suffix: string;
    readonly coverageId?: string;
    readonly sourceIdentity?: string;
    readonly nativeAddress?: string;
  },
): OmdbSourceResult {
  const sourceIdentity = input.sourceIdentity ?? source.record.sourceIdentity;
  const nativeAddress = input.nativeAddress ?? source.record.nativeAddress;
  const record: SourceRecord = {
    ...source.record,
    id: `${source.record.id}-${input.suffix}`,
    sourceIdentity,
    nativeAddress,
    coverage: {
      ...source.record.coverage,
      ...(input.coverageId === undefined ? {} : { id: input.coverageId }),
    },
  };
  return {
    record,
    interpretation: {
      ...source.interpretation,
      id: `${source.interpretation.id}-${input.suffix}`,
      sourceRecordIds: [record.id],
      sourceIdentity,
      sourceAddress: nativeAddress,
      metadata: source.interpretation.metadata.map((assertion, index) => ({
        ...assertion,
        sourceSlot: `${assertion.sourceSlot}.${input.suffix}.${index}`,
        sourceRecordIds: [record.id],
      })),
    },
  };
}

const omdbEvidence = {
  kind: "source-association" as const,
  sourceIdentity: "omdb",
  sourceAddress: "omdb:imdb:tt1234567",
  explanation: "existing exact association",
  producer: {
    capabilityId: "application.known-source-association",
    capabilityVersion: "1",
    contractVersion: "1",
  },
};

async function omdbSourceResult(input: {
  readonly title?: string;
  readonly awards?: string;
  readonly poster?: string;
}): Promise<OmdbSourceResult> {
  const collector = new OmdbCollector({
    apiKey: "private-test-key",
    request: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      arrayBuffer: async () =>
        new TextEncoder().encode(
          JSON.stringify({
            Response: "True",
            imdbID: "tt1234567",
            Title: input.title ?? "Example Film",
            Year: "2004",
            Released: "06 Aug 2004",
            ...(input.awards === undefined ? {} : { Awards: input.awards }),
            ...(input.poster === undefined ? {} : { Poster: input.poster }),
          }),
        ).buffer,
    }),
  });
  const collected = await collector.collect(omdbEvidence);
  const record = collected.records[0];
  if (record === undefined)
    throw new Error("OMDb fixture did not form a record");
  return {
    record,
    interpretation: new OmdbSourceInterpreter().interpret({
      evidence: [omdbEvidence],
      sourceRecords: collected.records,
    }),
  };
}

function omdbExecution(id: string): WorkflowExecution {
  return {
    id,
    selection: { intent: "metadata-refresh" },
    status: "running",
    stage: "recognition",
    sourceRecordIds: [],
    compatibility: {
      workflowVersion: "asset-refresh/2",
      policyVersion: "omdb-source-refresh-test",
      capabilityCoordinates: [],
    },
    dispositions: [],
  };
}

function omdbAcceptedRecognition(
  source: OmdbSourceResult,
): AcceptedRecognition {
  const proposal = {
    id: "omdb-initial-proposal",
    basis: {
      kind: "source-interpretation" as const,
      interpretation: source.interpretation,
    },
    ruleResults: [
      {
        capabilityId: "omdb.exact-recognizer",
        capabilityVersion: "1",
        ruleId: "exact-imdb-address",
        ruleVersion: "1",
        outcome: "satisfied" as const,
        explanation: "seed already-accepted OMDb association",
        evidence: [],
      },
    ],
  };
  return {
    proposal,
    entity: { id: "omdb-film", kind: "digital-asset" },
    recognitionSourceAssociation: {
      id: "omdb-association",
      subjectId: "omdb-film",
      sourceIdentity: "omdb",
      nativeAddress: "omdb:imdb:tt1234567",
      proposalId: proposal.id,
    },
    sourceAssociations: [
      {
        id: "omdb-association",
        subjectId: "omdb-film",
        sourceIdentity: "omdb",
        nativeAddress: "omdb:imdb:tt1234567",
        proposalId: proposal.id,
      },
    ],
    recognitionDecision: {
      id: "omdb-decision",
      proposalId: proposal.id,
      assetId: "omdb-film",
      acceptedRuleResults: proposal.ruleResults,
    },
    artifacts: [],
    locations: [],
    blobs: [],
    artifactRevisions: [],
    artifactAssociations: [],
    metadata: source.interpretation.metadata,
  };
}

function omdbAcceptedRecognitionForAsset(input: {
  readonly source: OmdbSourceResult;
  readonly assetId: string;
  readonly associationId: string;
  readonly proposalId: string;
  readonly decisionId: string;
  readonly secondary?: { readonly id: string; readonly label: string };
}): AcceptedRecognition {
  const secondary =
    input.secondary === undefined
      ? []
      : [
          {
            id: input.secondary.id,
            kind: "entity" as const,
            sourceIdentity: "omdb",
            sourceKey: input.secondary.id,
            identityNamespace: "omdb.test.secondary",
            label: input.secondary.label,
            sourceRecordIds: [input.source.record.id],
          },
        ];
  const metadata = [
    ...input.source.interpretation.metadata,
    ...(input.secondary === undefined
      ? []
      : [
          {
            subjectId: input.secondary.id,
            property: "asset.secondary-label",
            sourceSlot: "omdb.movie.secondary-label",
            value: input.secondary.label,
            sourceRecordIds: [input.source.record.id],
          },
        ]),
  ];
  const interpretation: SourceInterpretationBatch = {
    ...input.source.interpretation,
    id: `${input.proposalId}-interpretation`,
    metadata,
    ...(secondary.length === 0 ? {} : { entities: secondary }),
  };
  const ruleResults = [
    {
      capabilityId: "omdb.exact-recognizer",
      capabilityVersion: "1",
      ruleId: "exact-imdb-address",
      ruleVersion: "1",
      outcome: "satisfied" as const,
      explanation: "seed accepted OMDb association for an independent asset",
      evidence: [],
    },
  ];
  const proposal = {
    id: input.proposalId,
    basis: { kind: "source-interpretation" as const, interpretation },
    ruleResults,
  };
  return {
    proposal,
    entity: { id: input.assetId, kind: "digital-asset" },
    recognitionSourceAssociation: {
      id: input.associationId,
      subjectId: input.assetId,
      sourceIdentity: "omdb",
      nativeAddress: "omdb:imdb:tt1234567",
      proposalId: proposal.id,
    },
    sourceAssociations: [
      {
        id: input.associationId,
        subjectId: input.assetId,
        sourceIdentity: "omdb",
        nativeAddress: "omdb:imdb:tt1234567",
        proposalId: proposal.id,
      },
    ],
    recognitionDecision: {
      id: input.decisionId,
      proposalId: proposal.id,
      assetId: input.assetId,
      acceptedRuleResults: proposal.ruleResults,
    },
    artifacts: [],
    locations: [],
    blobs: [],
    artifactRevisions: [],
    artifactAssociations: [],
    metadata,
    ...(secondary.length === 0 ? {} : { entities: secondary }),
  };
}

async function tmdbAcceptedRecognitionFromShippedAdapter(): Promise<{
  readonly records: readonly SourceRecord[];
  readonly record: SourceRecord;
  readonly accepted: AcceptedRecognition;
}> {
  const evidence = [
    {
      kind: "directed-source-address" as const,
      sourceIdentity: "tmdb",
      sourceAddress: "https://www.themoviedb.org/movie/123",
      explanation: "fixed production-composition fixture",
      producer: {
        capabilityId: "application.directed-recognition",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    },
  ] as const;
  const collector = new TmdbCollector({
    accessToken: "private-test-token",
    request: async (address) => {
      const url = new URL(address);
      const jsonResponse = (body: unknown) => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        arrayBuffer: async () =>
          new TextEncoder().encode(JSON.stringify(body)).buffer,
      });
      if (url.pathname === "/3/movie/123") {
        return jsonResponse({
          id: 123,
          title: "Example Film",
          original_title: "Example Film",
          release_date: "2004-08-06",
          runtime: 123,
          imdb_id: "tt1234567",
          genres: [
            { id: 18, name: "Drama" },
            { id: 53, name: "Thriller" },
          ],
          alternative_titles: { titles: [] },
          images: { posters: [], backdrops: [] },
        });
      }
      if (url.pathname === "/3/movie/123/credits")
        return jsonResponse({ id: 123, crew: [], cast: [] });
      if (url.pathname === "/3/movie/123/translations")
        return jsonResponse({ id: 123, translations: [] });
      throw new Error(`Unexpected TMDB fixture request ${url.pathname}`);
    },
  });
  const collected = await collector.collect(evidence[0]);
  if (collected.failures.length > 0)
    throw new Error("TMDB fixture collection unexpectedly failed");
  const interpretation = new TmdbSourceInterpreter().interpret({
    evidence,
    sourceRecords: collected.records,
  });
  const record = collected.records.find(
    (candidate) => candidate.coverage.id === "tmdb.movie",
  );
  if (record === undefined)
    throw new Error("TMDB fixture collection did not retain the movie record");
  const proposal = {
    ...new TmdbStrictFilmRecognizer().recognize({
      evidence,
      basis: { kind: "source-interpretation", interpretation },
    }),
    basis: { kind: "source-interpretation" as const, interpretation },
  };
  return {
    records: collected.records,
    record,
    accepted: {
      proposal,
      entity: { id: "tmdb-film", kind: "digital-asset" },
      recognitionSourceAssociation: {
        id: "tmdb-shipped-association",
        subjectId: "tmdb-film",
        sourceIdentity: interpretation.sourceIdentity,
        nativeAddress: interpretation.sourceAddress,
        proposalId: proposal.id,
      },
      sourceAssociations: [
        {
          id: "tmdb-shipped-association",
          subjectId: "tmdb-film",
          sourceIdentity: interpretation.sourceIdentity,
          nativeAddress: interpretation.sourceAddress,
          proposalId: proposal.id,
        },
      ],
      recognitionDecision: {
        id: "tmdb-shipped-decision",
        proposalId: proposal.id,
        assetId: "tmdb-film",
        acceptedRuleResults: proposal.ruleResults,
      },
      artifacts: [],
      locations: [],
      blobs: [],
      artifactRevisions: [],
      artifactAssociations: [],
      metadata: interpretation.metadata,
    },
  };
}

function tmdbAcceptedRecognition(): {
  readonly record: SourceRecord;
  readonly accepted: AcceptedRecognition;
} {
  const record: SourceRecord = {
    id: "tmdb-initial-record",
    sourceIdentity: "tmdb",
    nativeAddress: "tmdb:movie:123",
    mediaType: "application/json",
    acquiredAt: "2026-08-02T00:00:00.000Z",
    acquisition: {
      requestedAddress: "https://api.themoviedb.org/3/movie/123",
      method: "GET",
      authorized: true,
    },
    coverage: {
      id: "tmdb.movie",
      completeness: "complete",
      authority: "official",
    },
    digest: "tmdb-initial-digest",
    body: '{"id":123,"imdb_id":"tt1234567","title":"Example Film"}',
  };
  const interpretation: SourceInterpretationBatch = {
    id: "tmdb-initial-interpretation",
    producer: {
      capabilityId: "tmdb.source-interpreter",
      capabilityVersion: "1",
      contractVersion: "1",
    },
    sourceRecordIds: [record.id],
    sourceIdentity: record.sourceIdentity,
    sourceAddress: record.nativeAddress,
    metadata: [
      {
        property: "asset.title",
        sourceSlot: "tmdb.movie.title",
        value: "Example Film",
        sourceRecordIds: [record.id],
      },
      {
        property: "external.imdb-id",
        sourceSlot: "tmdb.movie.imdb-id",
        value: "tt1234567",
        sourceRecordIds: [record.id],
      },
      {
        property: "asset.genre",
        sourceSlot: "tmdb.movie.genre.0",
        value: "Drama",
        sourceRecordIds: [record.id],
      },
      {
        property: "asset.genre",
        sourceSlot: "tmdb.movie.genre.1",
        value: "Thriller",
        sourceRecordIds: [record.id],
      },
    ],
    sourceArtifacts: [],
  };
  const proposal = {
    id: "tmdb-initial-proposal",
    basis: { kind: "source-interpretation" as const, interpretation },
    ruleResults: [
      {
        capabilityId: "tmdb.exact-recognizer",
        capabilityVersion: "1",
        ruleId: "exact-tmdb-address",
        ruleVersion: "1",
        outcome: "satisfied" as const,
        explanation: "seed accepted TMDB recognition identity",
        evidence: [],
      },
    ],
  };
  return {
    record,
    accepted: {
      proposal,
      entity: { id: "tmdb-film", kind: "digital-asset" },
      recognitionSourceAssociation: {
        id: "tmdb-association",
        subjectId: "tmdb-film",
        sourceIdentity: record.sourceIdentity,
        nativeAddress: record.nativeAddress,
        proposalId: proposal.id,
      },
      sourceAssociations: [
        {
          id: "tmdb-association",
          subjectId: "tmdb-film",
          sourceIdentity: record.sourceIdentity,
          nativeAddress: record.nativeAddress,
          proposalId: proposal.id,
        },
      ],
      recognitionDecision: {
        id: "tmdb-decision",
        proposalId: proposal.id,
        assetId: "tmdb-film",
        acceptedRuleResults: proposal.ruleResults,
      },
      artifacts: [],
      locations: [],
      blobs: [],
      artifactRevisions: [],
      artifactAssociations: [],
      metadata: interpretation.metadata,
    },
  };
}

function omdbEnrichmentExecution(input: {
  readonly id: string;
  readonly baseline: AcceptedRecognition;
  readonly metadataSourceRecordId?: string;
  readonly source: OmdbSourceResult;
  readonly sourceAssociation: {
    readonly id: string;
    readonly subjectId: string;
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
    readonly proposalId: string;
  };
  readonly stage: "association-interpreted" | "applied";
}): WorkflowExecution {
  const key = "source-enrichment:tmdb-film:omdb.source-interpreter";
  return {
    ...omdbExecution(input.id),
    stage: "source-records-retained",
    sourceRecordIds: [input.source.record.id],
    dispositions: [
      {
        key,
        status:
          input.stage === "applied"
            ? ("completed" as const)
            : ("running" as const),
      },
    ],
    sourceEnrichments: [
      {
        key,
        subjectId: input.baseline.entity.id,
        subject: {
          subjectId: input.baseline.entity.id,
          recognitionSourceAssociation:
            input.baseline.recognitionSourceAssociation,
          recognitionDecisionId: input.baseline.recognitionDecision.id,
          sourceAssociations: [input.baseline.recognitionSourceAssociation],
          metadata: input.baseline.metadata,
          metadataSourceRecords: [
            {
              id: input.metadataSourceRecordId ?? "tmdb-initial-record",
              sourceIdentity: "tmdb",
            },
          ],
          informationRequirement: {
            metadataUsageContext: "asset.ordinary",
            metadata: [],
            artifactRoles: [],
            relationshipTypes: [],
          },
        },
        evidence: omdbEvidence,
        fulfilledArtifactRoles: [],
        metadataPolicyIds: [],
        stage: input.stage,
        sourceAssociation: input.recognitionSourceAssociation,
        interpretation: input.source.interpretation,
        sourceRecordIds: [input.source.record.id],
        sourceArtifacts: input.source.interpretation.sourceArtifacts,
      },
    ],
  };
}

function omdbCandidateEnrichmentCheckpoint(
  baseline: AcceptedRecognition,
): Extract<
  SourceEnrichmentCheckpoint,
  { readonly stage: "candidate-interpreted" }
> {
  return {
    key: "source-enrichment:tmdb-film:omdb.source-interpreter",
    subjectId: baseline.entity.id,
    stage: "candidate-interpreted",
    subject: {
      subjectId: baseline.entity.id,
      recognitionSourceAssociation: baseline.recognitionSourceAssociation,
      recognitionDecisionId: baseline.recognitionDecision.id,
      sourceAssociations: [baseline.recognitionSourceAssociation],
      metadata: baseline.metadata,
      metadataSourceRecords: [
        { id: "tmdb-initial-record", sourceIdentity: "tmdb" },
      ],
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        artifactRoles: [],
        relationshipTypes: [],
      },
    },
    evidence: omdbEvidence,
    fulfilledArtifactRoles: [],
    metadataPolicyIds: [],
  };
}

function omdbManagedArtifactExecution(input: {
  readonly id: string;
  readonly sourceRecordId: string;
  readonly candidate: SourceInterpretationBatch["sourceArtifacts"][number];
}): WorkflowExecution {
  const artifact = omdbManagedArtifactFacts({
    subjectId: "omdb-film",
    sourceRecordId: input.sourceRecordId,
  });
  return {
    ...omdbExecution(input.id),
    stage: "source-artifacts-stored",
    sourceRecordIds: [input.sourceRecordId],
    sourceArtifactAcquisitions: [
      {
        candidateId: input.candidate.id,
        sourceRecordId: input.sourceRecordId,
        subjectId: "omdb-film",
        role: input.candidate.role,
        acquisitionReference: input.candidate.acquisitionReference,
        stagedReference: "staged:omdb-primary-cover",
        digest: artifact.blobs[0].digest,
        mediaType: input.candidate.mediaType,
      },
    ],
    managedSourceArtifacts: [
      {
        candidateId: input.candidate.id,
        sourceRecordId: input.sourceRecordId,
        subjectId: "omdb-film",
        role: input.candidate.role,
        acquisitionReference: input.candidate.acquisitionReference,
        blob: artifact.blobs[0],
        location: { address: artifact.locations[0].address },
      },
    ],
  };
}

function omdbManagedArtifactFacts(input: {
  readonly subjectId: string;
  readonly sourceRecordId: string;
  readonly suffix?: string;
}) {
  const suffix = input.suffix === undefined ? "" : `-${input.suffix}`;
  const artifactId = `omdb-managed-artifact${suffix}`;
  const locationId = `omdb-managed-location${suffix}`;
  const digest = `omdb-managed-digest${suffix}`;
  const revisionId = `omdb-managed-revision${suffix}`;
  const associationId = `omdb-managed-association${suffix}`;
  return {
    artifacts: [{ id: artifactId }],
    locations: [
      {
        id: locationId,
        artifactId,
        address: `/managed/${artifactId}`,
        kind: "managed" as const,
      },
    ],
    blobs: [
      {
        digest,
        mediaType: "image/jpeg",
        byteLength: 4,
      },
    ],
    revisions: [
      {
        id: revisionId,
        artifactId,
        blobDigest: digest,
      },
    ],
    associations: [
      {
        id: associationId,
        subjectId: input.subjectId,
        artifactId,
        role: "asset.primary-cover",
        sourceRecordIds: [input.sourceRecordId],
      },
    ],
  };
}

async function createOmdbSourceRefreshRun(input: {
  readonly catalogue: SqliteCatalogue;
  readonly executionId: string;
  readonly runId: string;
  readonly subjectId: string;
  readonly sourceAssociationId: string;
  readonly baselineSourceRecordId: string;
}) {
  await input.catalogue.createExecution(omdbExecution(input.executionId));
  return await input.catalogue.createSourceRefreshRun({
    executionId: input.executionId,
    run: {
      id: input.runId,
      initiatedBy: "user-1",
      initiatedAt: "2026-08-02T00:00:00.000Z",
      requestedSelection: {
        subjectId: input.subjectId,
        sourceAssociationId: input.sourceAssociationId,
        sourceIdentity: "omdb",
        nativeAddress: "omdb:imdb:tt1234567",
        selectors: [{ kind: "metadata-property", property: "asset.awards" }],
      },
      reviewPolicy: "automatic",
      baselineLineageHeads: [
        {
          sourceIdentity: "omdb",
          nativeAddress: "omdb:imdb:tt1234567",
          coverageId: "omdb.movie",
          sourceRecordId: input.baselineSourceRecordId,
        },
      ],
    },
  });
}

function acceptedRecognition(): AcceptedRecognition {
  const interpretation = {
    id: "dlsite-interpretation",
    producer: {
      capabilityId: "dlsite.interpreter",
      capabilityVersion: "1",
      contractVersion: "1",
    },
    sourceRecordIds: ["dlsite-record"],
    sourceIdentity: "dlsite",
    sourceAddress:
      "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
    metadata: [
      {
        property: "asset.title",
        sourceSlot: "dlsite.title",
        value: "DLsite work",
        sourceRecordIds: ["dlsite-record"],
      },
    ],
    sourceArtifacts: [],
    entities: [
      {
        id: "dlsite-voice",
        kind: "persona" as const,
        sourceIdentity: "dlsite",
        sourceKey: "dlsite-voice",
        identityNamespace: "dlsite.credit.voice",
        label: "DLsite voice",
        sourceRecordIds: ["dlsite-record"],
      },
    ],
    entityMentions: [
      {
        id: "dlsite-voice-mention",
        sourceRecordIds: ["dlsite-record"],
        sourceIdentity: "dlsite",
        field: "voice",
        role: "voice",
        label: "DLsite voice",
        identityNamespace: "dlsite.credit.voice",
        sourceKey: "dlsite-voice",
      },
    ],
    entityResolutionDecisions: [
      {
        id: "dlsite-voice-resolution",
        mentionId: "dlsite-voice-mention",
        entityId: "dlsite-voice",
        rule: "source-field-role-exact" as const,
        sourceRecordIds: ["dlsite-record"],
      },
    ],
  };
  const proposal = {
    id: "dlsite-proposal",
    basis: { kind: "source-interpretation" as const, interpretation },
    ruleResults: [
      {
        capabilityId: "dlsite.recognizer",
        capabilityVersion: "1",
        ruleId: "exact-source-address",
        ruleVersion: "1",
        outcome: "satisfied" as const,
        explanation: "exact DLsite source address",
        evidence: [],
      },
    ],
  };
  return {
    proposal,
    entity: { id: "dlsite-work", kind: "digital-asset" },
    recognitionSourceAssociation: {
      id: "dlsite-association",
      subjectId: "dlsite-work",
      sourceIdentity: "dlsite",
      nativeAddress:
        "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
      proposalId: proposal.id,
    },
    sourceAssociations: [
      {
        id: "dlsite-association",
        subjectId: "dlsite-work",
        sourceIdentity: "dlsite",
        nativeAddress:
          "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
        proposalId: proposal.id,
      },
    ],
    recognitionDecision: {
      id: "dlsite-decision",
      proposalId: proposal.id,
      assetId: "dlsite-work",
      acceptedRuleResults: proposal.ruleResults,
    },
    artifacts: [{ id: "dlsite-cover" }],
    locations: [
      {
        id: "dlsite-cover-location",
        artifactId: "dlsite-cover",
        address: "/managed/dlsite-cover",
        kind: "managed",
      },
    ],
    blobs: [
      {
        digest: "dlsite-cover-digest",
        mediaType: "image/jpeg",
        byteLength: 4,
      },
    ],
    artifactRevisions: [
      {
        id: "dlsite-cover-revision",
        artifactId: "dlsite-cover",
        blobDigest: "dlsite-cover-digest",
      },
    ],
    artifactAssociations: [
      {
        id: "dlsite-cover-association",
        subjectId: "dlsite-work",
        artifactId: "dlsite-cover",
        role: "asset.primary-cover",
      },
    ],
    metadata: interpretation.metadata,
    entities: [
      {
        id: "dlsite-voice",
        kind: "persona",
        sourceIdentity: "dlsite",
        sourceKey: "dlsite-voice",
        identityNamespace: "dlsite.credit.voice",
        label: "DLsite voice",
        sourceRecordIds: ["dlsite-record"],
      },
    ],
    entityMentions: interpretation.entityMentions,
    entityResolutionDecisions: interpretation.entityResolutionDecisions,
    relationships: [
      {
        id: "dlsite-voice-relationship",
        subjectId: "dlsite-work",
        participantId: "dlsite-voice",
        type: "asset.contribution",
        role: "voice",
        sourceSlot: "dlsite.credit.voice",
        sourceRecordIds: ["dlsite-record"],
      },
    ],
  };
}

function continuityConflictRecognition(): AcceptedRecognition {
  const original = acceptedRecognition();
  const sourceRecordId = "dlsite-continuity-record";
  const proposal = {
    ...original.proposal,
    id: "dlsite-continuity-proposal",
    basis: {
      kind: "source-interpretation" as const,
      interpretation: {
        ...original.proposal.basis.interpretation,
        id: "dlsite-continuity-interpretation",
        sourceRecordIds: [sourceRecordId],
        metadata: [
          {
            property: "asset.title",
            sourceSlot: "dlsite.title",
            // 相同文本不得折叠不同的已接受身份。
            value: "DLsite work",
            sourceRecordIds: [sourceRecordId],
          },
        ],
        entities: [],
        entityMentions: [],
        entityResolutionDecisions: [],
      },
    },
  };
  return {
    ...original,
    proposal,
    entity: { id: "dlsite-continuity-work", kind: "digital-asset" },
    recognitionSourceAssociation: {
      id: "dlsite-continuity-association",
      subjectId: "dlsite-continuity-work",
      sourceIdentity: "dlsite",
      nativeAddress:
        "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
      proposalId: proposal.id,
    },
    sourceAssociations: [
      {
        id: "dlsite-continuity-association",
        subjectId: "dlsite-continuity-work",
        sourceIdentity: "dlsite",
        nativeAddress:
          "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
        proposalId: proposal.id,
      },
    ],
    recognitionDecision: {
      id: "dlsite-continuity-decision",
      proposalId: proposal.id,
      assetId: "dlsite-continuity-work",
      acceptedRuleResults: proposal.ruleResults,
    },
    artifacts: [{ id: "dlsite-continuity-cover" }],
    locations: [
      {
        id: "dlsite-continuity-cover-location",
        artifactId: "dlsite-continuity-cover",
        // 相同托管路径和相同 `Blob` 仍是物料事实，不是重写稳定产物关联的隐式许可。
        address: "/managed/dlsite-cover",
        kind: "managed",
      },
    ],
    blobs: [
      {
        digest: "dlsite-cover-digest",
        mediaType: "image/jpeg",
        byteLength: 4,
      },
    ],
    artifactRevisions: [
      {
        id: "dlsite-continuity-cover-revision",
        artifactId: "dlsite-continuity-cover",
        blobDigest: "dlsite-cover-digest",
      },
    ],
    artifactAssociations: [
      {
        id: "dlsite-cover-association",
        subjectId: "dlsite-continuity-work",
        artifactId: "dlsite-continuity-cover",
        role: "asset.primary-cover",
      },
    ],
    metadata: proposal.basis.interpretation.metadata,
    entities: [],
    entityMentions: [],
    entityResolutionDecisions: [],
    relationships: [],
  };
}

function independentlyAcceptedRecognition(): AcceptedRecognition {
  const alternate = continuityConflictRecognition();
  const sourceRecordId = "dlsite-independent-record";
  const sourceAddress =
    "https://www.dlsite.com/maniax/work/=/product_id/RJ01234567.html";
  const proposal = {
    ...alternate.proposal,
    id: "dlsite-independent-proposal",
    basis: {
      kind: "source-interpretation" as const,
      interpretation: {
        ...alternate.proposal.basis.interpretation,
        id: "dlsite-independent-interpretation",
        sourceRecordIds: [sourceRecordId],
        sourceAddress,
        metadata: alternate.proposal.basis.interpretation.metadata.map(
          (assertion) => ({
            ...assertion,
            sourceRecordIds: [sourceRecordId],
          }),
        ),
      },
    },
  };
  return {
    ...alternate,
    proposal,
    entity: { id: "dlsite-independent-work", kind: "digital-asset" },
    recognitionSourceAssociation: {
      id: "dlsite-independent-association",
      subjectId: "dlsite-independent-work",
      sourceIdentity: "dlsite",
      nativeAddress: sourceAddress,
      proposalId: proposal.id,
    },
    sourceAssociations: [
      {
        id: "dlsite-independent-association",
        subjectId: "dlsite-independent-work",
        sourceIdentity: "dlsite",
        nativeAddress: sourceAddress,
        proposalId: proposal.id,
      },
    ],
    recognitionDecision: {
      id: "dlsite-independent-decision",
      proposalId: proposal.id,
      assetId: "dlsite-independent-work",
      acceptedRuleResults: proposal.ruleResults,
    },
    artifacts: [{ id: "dlsite-independent-cover" }],
    locations: [
      {
        id: "dlsite-independent-cover-location",
        artifactId: "dlsite-independent-cover",
        address: "/managed/dlsite-cover",
        kind: "managed",
      },
    ],
    artifactRevisions: [
      {
        id: "dlsite-independent-cover-revision",
        artifactId: "dlsite-independent-cover",
        blobDigest: "dlsite-cover-digest",
      },
    ],
    artifactAssociations: [
      {
        id: "dlsite-independent-cover-association",
        subjectId: "dlsite-independent-work",
        artifactId: "dlsite-independent-cover",
        role: "asset.primary-cover",
      },
    ],
    metadata: proposal.basis.interpretation.metadata,
  };
}
