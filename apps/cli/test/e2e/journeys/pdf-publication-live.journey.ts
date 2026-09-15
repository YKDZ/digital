import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AssetRefreshInspection } from "@digital/application";
import type { RawFilesystemSnapshot } from "@digital/test-support";

import {
  assertFixedCorpusContentBaselineSubset,
  captureFixedCorpusSnapshots,
  fixedCorpusContentDigestsFromSnapshots,
  fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle,
  fixedCorpusRoots,
  type FixedCorpusContentDigest,
  type FixedCorpusRoot,
} from "../fixed-corpus.ts";
import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyCommand,
  type CliJourneyContext,
  type CliJourneyResult,
} from "../journey.ts";

const ownerTicket = "v1-live-acceptance/issues/04-pdf-series-live-gate.md";
export const approvedPdfOracleSliceDigest =
  "deced47cbd155603a5917e3404122c21e6f1038680128942f52c66e335ffce95";

type PdfPublicationOracle = {
  readonly logicalRoot: string;
  readonly relativePath: string;
  readonly revision: {
    readonly digest: string;
    readonly mediaType: "application/pdf";
    readonly byteLength: number;
  };
  readonly pageCount: number;
  readonly documentAuthor: string;
  readonly cover: {
    readonly locator: "pdf:page[1]";
    readonly mediaType: "image/png";
  };
};

type PdfOracle = {
  readonly reviews: {
    readonly pdf: {
      readonly status: string;
      readonly reviewedAt: string;
    };
  };
  readonly dedicatedIntegrationOwnershipGroups: readonly unknown[];
  readonly pdfPublications: readonly PdfPublicationOracle[];
};

type JourneyState = {
  readonly root: FixedCorpusRoot;
  readonly publications: readonly PdfPublicationOracle[];
  readonly before: ReadonlyMap<string, RawFilesystemSnapshot>;
  readonly deepBefore?: ReadonlyMap<string, FixedCorpusContentDigest>;
};

type Accepted = NonNullable<AssetRefreshInspection["accepted"]>;

type PublicationSourceInput = {
  readonly relativePath: string;
  readonly isbn: string;
  readonly sourceIdentity: "taiwan-kadokawa" | "kadokawa-jp";
  readonly productAddress: string;
  readonly expectedTitle: string;
  readonly expectedCoverage: readonly string[];
};

const publicationSourceInputs: readonly PublicationSourceInput[] = [
  {
    relativePath:
      "01. /终将成为你 佐伯沙弥香的追忆/终将成为你 佐伯沙弥香的追忆 - 入间人间 (2020).pdf",
    isbn: "9789577435064",
    sourceIdentity: "taiwan-kadokawa",
    productAddress: "https://www.kadokawa.com.tw/products/9789577435064",
    expectedTitle: "終將成為妳 關於佐伯沙彌香 (1)",
    expectedCoverage: ["taiwan-kadokawa.product-page"],
  },
  {
    relativePath:
      "02. /终将成为你 佐伯沙弥香的追忆2/终将成为你 佐伯沙弥香的追忆2 - 入间人间 (2020).pdf",
    isbn: "9789577439680",
    sourceIdentity: "taiwan-kadokawa",
    productAddress: "https://www.kadokawa.com.tw/products/9789577439680",
    expectedTitle: "終將成為妳 關於佐伯沙彌香 (2)",
    expectedCoverage: ["taiwan-kadokawa.product-page"],
  },
  {
    relativePath:
      "03. /终将成为你 佐伯沙弥香的追忆3/终将成为你 佐伯沙弥香的追忆3 - 入间人间 (2020).pdf",
    isbn: "9784049131291",
    sourceIdentity: "kadokawa-jp",
    productAddress: "https://www.kadokawa.co.jp/product/321912000002/",
    expectedTitle: "やがて君になる　佐伯沙弥香について(3)",
    expectedCoverage: ["kadokawa-jp.search", "kadokawa-jp.detail"],
  },
];

type SourceDecisionView = {
  readonly executionId: string;
  readonly status: string;
  readonly state: string;
  readonly candidates: readonly {
    readonly reference: string;
    readonly outcome: string;
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  }[];
  readonly preview?: {
    readonly id: string;
    readonly status: string;
    readonly projected: {
      readonly sourceAssociations: readonly {
        readonly sourceIdentity: string;
        readonly nativeAddress: string;
      }[];
    };
  };
};

type AppliedPreviewView = {
  readonly preview: {
    readonly status: string;
    readonly projected: {
      readonly sourceAssociations: readonly {
        readonly sourceIdentity: string;
        readonly nativeAddress: string;
      }[];
    };
  };
};

type CorrectionSubjectView = {
  readonly current: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  }[];
  readonly historical: readonly unknown[];
};

const stateByContext = new Map<string, JourneyState>();
const sourceBusinessProjection = new Map<string, unknown>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pdfOracleSlice(rawOracle: unknown): unknown {
  const oracle = record(rawOracle);
  const reviews = record(oracle?.reviews);
  const groups = Array.isArray(oracle?.dedicatedIntegrationOwnershipGroups)
    ? oracle.dedicatedIntegrationOwnershipGroups
    : [];
  return {
    reviews: { pdf: reviews?.pdf },
    dedicatedIntegrationOwnershipGroups: groups.filter(
      (group) => record(group)?.ownerTicket === ownerTicket,
    ),
    pdfPublications: oracle?.pdfPublications,
  };
}

/** 在任何真实媒体或 CLI 动作前固定本 gate 自己审核过的 oracle 语义。 */
export function assertApprovedPdfOracleSlice(rawOracle: unknown): void {
  const digest = createHash("sha256")
    .update(JSON.stringify(pdfOracleSlice(rawOracle)))
    .digest("hex");
  assert.equal(
    digest,
    approvedPdfOracleSliceDigest,
    "PDF reviewed oracle slice digest drifted",
  );
}

function stateKey(context: CliJourneyContext): string {
  return `${context.mode}\u0000${context.workDir}`;
}

function currentState(context: CliJourneyContext): JourneyState {
  const state = stateByContext.get(stateKey(context));
  if (state === undefined)
    throw new Error("PDF publication live journey setup did not run");
  return state;
}

function corpusRoot(context: CliJourneyContext): string {
  return path.resolve(
    context.packageRoot,
    "../..",
    ".scratch/acceptance-corpus",
  );
}

function inspection(result: CliJourneyResult | undefined) {
  return JSON.parse(result?.stdout ?? "{}") as AssetRefreshInspection;
}

function jsonResult(
  result: CliJourneyResult | undefined,
): Record<string, unknown> {
  const value = record(JSON.parse(result?.stdout ?? "{}"));
  if (value === undefined) throw new Error("CLI 没有返回 JSON 对象");
  return value;
}

function scannedAssetId(
  result: CliJourneyResult | undefined,
  relativePath: string,
): string {
  const item = (inspection(result).itemResults ?? []).find((candidate) =>
    candidate.relativePaths.includes(relativePath),
  );
  const assetId = item?.accepted?.entity.id;
  if (assetId === undefined)
    throw new Error(`初次扫描没有返回 PDF 内容：${relativePath}`);
  return assetId;
}

function decisionExecutionId(result: CliJourneyResult | undefined): string {
  const value = jsonResult(result).executionId;
  if (typeof value !== "string" || value.length === 0)
    throw new Error("来源决定没有返回执行编号");
  return value;
}

function exactCandidateReference(
  result: CliJourneyResult | undefined,
  productAddress: string,
): string {
  const value = jsonResult(result);
  const matches = Array.isArray(value.candidates)
    ? value.candidates.filter(
        (candidate: Record<string, unknown>) =>
          candidate.nativeAddress === productAddress &&
          candidate.outcome === "accepted",
      )
    : [];
  assert.equal(matches.length, 1, `来源候选没有唯一命中 ${productAddress}`);
  const reference = matches[0]?.reference;
  if (typeof reference !== "string" || reference.length === 0)
    throw new Error("来源候选没有返回公开引用");
  return reference;
}

function previewId(result: CliJourneyResult | undefined): string {
  const value = record(jsonResult(result).preview)?.id;
  if (typeof value !== "string" || value.length === 0)
    throw new Error("来源决定没有返回待确认预演");
  return value;
}

function exactLocalFact(
  accepted: Accepted,
  expected: {
    readonly property: string;
    readonly value: string;
    readonly locator: string;
  },
): void {
  const matches = accepted.metadata.filter(
    (fact) =>
      fact.property === expected.property &&
      fact.value === expected.value &&
      fact.observedArtifactPart?.locator === expected.locator,
  );
  assert.equal(
    matches.length,
    1,
    `missing exact PDF fact ${expected.property}`,
  );
  assert.deepEqual(matches[0]!.sourceRecordIds, []);
}

function stableBusinessProjection(value: AssetRefreshInspection): unknown {
  return (value.itemResults ?? []).map((item) => {
    const accepted = item.accepted;
    assert.ok(accepted);
    return {
      relativePaths: item.relativePaths,
      sourceAssociations: accepted.sourceAssociations,
      blobs: accepted.blobs
        .map((blob) => ({
          digest: blob.digest,
          mediaType: blob.mediaType,
          byteLength: blob.byteLength,
        }))
        .toSorted((left, right) => left.digest.localeCompare(right.digest)),
      metadata: accepted.metadata
        .map((fact) => ({
          property: fact.property,
          value: fact.value,
          locator: fact.observedArtifactPart?.locator,
        }))
        .toSorted((left, right) =>
          `${left.property}:${left.value}:${left.locator ?? ""}`.localeCompare(
            `${right.property}:${right.value}:${right.locator ?? ""}`,
          ),
        ),
      covers: accepted.artifactAssociations
        .filter((association) => association.role === "asset.primary-cover")
        .map((association) => association.observedArtifactPart?.locator),
      entityCount: accepted.currentRelatedEntities?.length ?? 0,
      mentionCount: accepted.entityMentions?.length ?? 0,
      relationshipCount: accepted.relationships?.length ?? 0,
    };
  });
}

function stablePublicationProjection(value: AssetRefreshInspection): unknown {
  const accepted = value.accepted;
  assert.ok(accepted);
  return {
    entityKind: accepted.entity.kind,
    sourceAssociations: accepted.sourceAssociations
      .map(({ sourceIdentity, nativeAddress }) => ({
        sourceIdentity,
        nativeAddress,
      }))
      .toSorted((left, right) =>
        left.nativeAddress.localeCompare(right.nativeAddress),
      ),
    sourceRecords: value.sourceRecords
      .map(({ sourceIdentity, nativeAddress, coverage }) => ({
        sourceIdentity,
        nativeAddress,
        coverage: coverage.id,
      }))
      .toSorted((left, right) => left.coverage.localeCompare(right.coverage)),
    metadata: accepted.metadata
      .map(({ property, value: factValue, sourceRecordIds }) => ({
        property,
        value: factValue,
        hasSourceProvenance: sourceRecordIds.length > 0,
      }))
      .toSorted((left, right) =>
        `${left.property}:${left.value}`.localeCompare(
          `${right.property}:${right.value}`,
        ),
      ),
    primaryCovers: accepted.artifactAssociations
      .filter(({ role }) => role === "asset.primary-cover")
      .map(({ observedArtifactPart, sourceRecordIds }) => ({
        locator: observedArtifactPart?.locator,
        hasSourceProvenance: (sourceRecordIds?.length ?? 0) > 0,
      })),
    entityCount: accepted.currentRelatedEntities?.length ?? 0,
    relationshipCount: accepted.relationships?.length ?? 0,
  };
}

const journey: CliJourney = {
  name: "pdf-publication-live",
  modes: ["source", "distribution"],
  async setup(context) {
    const untrustedOracle = JSON.parse(
      await readFile(
        path.join(corpusRoot(context), "references/reviewed-oracle.json"),
        "utf8",
      ),
    ) as unknown;
    assertApprovedPdfOracleSlice(untrustedOracle);
    const rawOracle = untrustedOracle as PdfOracle;
    assert.equal(rawOracle.reviews.pdf.status, "reviewed-local-format");
    assert.equal(rawOracle.reviews.pdf.reviewedAt, "2026-08-31");
    assert.equal(rawOracle.pdfPublications.length, 3);
    assert.equal(
      new Set(rawOracle.pdfPublications.map((item) => item.relativePath)).size,
      3,
    );
    assert.equal(
      new Set(rawOracle.pdfPublications.map((item) => item.logicalRoot)).size,
      1,
    );
    const allRoots = await fixedCorpusRoots(context);
    const owner = fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle(
      rawOracle,
      allRoots,
    ).find((group) => group.ownerTicket === ownerTicket);
    assert.ok(owner, "PDF fixed-corpus ownership group is missing");
    assert.equal(owner.status, "implemented");
    assert.equal(owner.journey, journey.name);
    assert.equal(owner.roots.length, 1);
    assert.equal(
      owner.roots[0]!.logicalRoot,
      rawOracle.pdfPublications[0]!.logicalRoot,
    );
    const deepIntegrity = process.env.DIGITAL_DEEP_CORPUS_INTEGRITY === "1";
    const before = await captureFixedCorpusSnapshots(
      owner.roots,
      deepIntegrity,
    );
    const deepBefore = deepIntegrity
      ? fixedCorpusContentDigestsFromSnapshots(owner.roots, before)
      : undefined;
    stateByContext.set(stateKey(context), {
      root: owner.roots[0]!,
      publications: rawOracle.pdfPublications,
      before,
      ...(deepBefore === undefined ? {} : { deepBefore }),
    });
    if (deepBefore !== undefined)
      await assertFixedCorpusContentBaselineSubset(context, deepBefore);
  },
  commands(context) {
    const state = currentState(context);
    const environment = {
      DIGITAL_PRODUCT_DATA: path.join(context.workDir, "product-data"),
    };
    const initialCommands: readonly CliJourneyCommand[] = [
      {
        name: "register PDF publication root",
        args: ["root-create", "PDF publication", state.root.directory],
        env: environment,
        haltOnFailure: true,
      },
      {
        name: "live refresh PDF publication root",
        args: (results: readonly CliJourneyResult[]) => [
          "scan",
          registeredObservedRootId(results[0]),
          "--scope",
          ".",
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
        env: environment,
        haltOnFailure: true,
      },
    ];
    const sourceCommands = publicationSourceInputs.flatMap(
      (publication, publicationIndex) => {
        const decisionIndex = 2 + publicationIndex * 7;
        const settleIndex = decisionIndex + 1;
        return [
          {
            name: `establish ${publication.isbn} source association`,
            args: (results: readonly CliJourneyResult[]) => [
              "source-decision",
              "establish",
              scannedAssetId(results[1], publication.relativePath),
              publication.sourceIdentity,
              JSON.stringify({ isbn: publication.isbn }),
              "--actor",
              "afk-live-gate",
              "--json",
            ],
            env: environment,
            haltOnFailure: true,
          },
          {
            name: `resolve ${publication.isbn} exact candidate after reopen`,
            args: (results: readonly CliJourneyResult[]) => {
              const decision = jsonResult(results[decisionIndex]);
              const executionId = decisionExecutionId(results[decisionIndex]);
              return decision.state === "awaiting-selection"
                ? [
                    "select-source-candidate",
                    executionId,
                    exactCandidateReference(
                      results[decisionIndex],
                      publication.productAddress,
                    ),
                    "--json",
                  ]
                : ["inspect-source-decision", executionId, "--json"];
            },
            env: environment,
            haltOnFailure: true,
          },
          {
            name: `inspect ${publication.isbn} retained source records`,
            args: (results: readonly CliJourneyResult[]) => [
              "inspect",
              decisionExecutionId(results[decisionIndex]),
              "--json",
            ],
            env: environment,
            haltOnFailure: true,
          },
          {
            name: `apply ${publication.isbn} source association`,
            args: (results: readonly CliJourneyResult[]) => [
              "apply-preview",
              previewId(results[settleIndex]),
              "--actor",
              "afk-live-gate",
              "--json",
            ],
            env: environment,
            haltOnFailure: true,
          },
          {
            name: `inspect ${publication.isbn} current association`,
            args: (results: readonly CliJourneyResult[]) => [
              "inspect-correction-subject",
              scannedAssetId(results[1], publication.relativePath),
              "--json",
            ],
            env: environment,
            haltOnFailure: true,
          },
          {
            name: `refresh ${publication.isbn} after reopen`,
            args: (results: readonly CliJourneyResult[]) => [
              "refresh-metadata",
              scannedAssetId(results[1], publication.relativePath),
              "--json",
            ],
            env: environment,
            haltOnFailure: true,
          },
          {
            name: `repeat ${publication.isbn} refresh`,
            args: (results: readonly CliJourneyResult[]) => [
              "refresh-metadata",
              scannedAssetId(results[1], publication.relativePath),
              "--json",
            ],
            env: environment,
            haltOnFailure: true,
          },
        ];
      },
    );
    return [...initialCommands, ...sourceCommands];
  },
  async assertions({ context, results }) {
    const state = currentState(context);
    assert.equal(results.length, 23);
    assert.equal(results[0]!.exitCode, 0, results[0]!.stderr);
    registeredObservedRootId(results[0]);
    assert.equal(results[1]!.exitCode, 0, results[1]!.stderr);
    const value = inspection(results[1]);
    assert.equal(value.execution.outcome, "accepted");
    const items = value.itemResults ?? [];
    assert.equal(items.length, 3, "one PDF root must yield three work items");
    const byRelativePath = new Map(
      items.map((item) => {
        assert.equal(item.relativePaths.length, 1);
        assert.equal(item.outcome, "accepted");
        assert.ok(item.accepted);
        return [item.relativePaths[0]!, item.accepted] as const;
      }),
    );
    assert.equal(byRelativePath.size, 3);
    const assetIds = new Set<string>();
    for (const publication of state.publications) {
      const accepted = byRelativePath.get(publication.relativePath);
      assert.ok(accepted, `missing PDF work item ${publication.relativePath}`);
      assert.equal(accepted.entity.kind, "digital-asset");
      assert.equal(assetIds.has(accepted.entity.id), false);
      assetIds.add(accepted.entity.id);
      assert.deepEqual(accepted.sourceAssociations, []);
      assert.equal(accepted.recognitionSourceAssociation, undefined);
      assert.match(accepted.recognitionExplanation, /无有效 ISBN/u);
      assert.deepEqual(value.sourceRecords, []);
      const revisionBlob = accepted.blobs.find(
        (blob) => blob.digest === publication.revision.digest,
      );
      assert.deepEqual(revisionBlob, publication.revision);
      const parentRevision = accepted.artifactRevisions.find(
        (revision) => revision.blobDigest === publication.revision.digest,
      );
      assert.ok(parentRevision);
      exactLocalFact(accepted, {
        property: "pdf.page-count",
        value: String(publication.pageCount),
        locator: "pdf:catalog/pages",
      });
      exactLocalFact(accepted, {
        property: "pdf.document-author",
        value: publication.documentAuthor,
        locator: "pdf:info/Author",
      });
      assert.equal(
        accepted.metadata.some((fact) => fact.property === "asset.title"),
        false,
      );
      assert.equal(
        accepted.metadata.some((fact) => fact.property === "book.contributor"),
        false,
      );
      const localFacts = accepted.metadata.filter(
        (fact) => fact.sourceRecordIds.length === 0,
      );
      assert.equal(localFacts.length, 2);
      const covers = accepted.artifactAssociations.filter(
        (association) => association.role === "asset.primary-cover",
      );
      assert.equal(covers.length, 1);
      assert.equal(
        covers[0]!.observedArtifactPart?.locator,
        publication.cover.locator,
      );
      assert.equal(
        covers[0]!.observedArtifactPart?.revisionId,
        parentRevision.id,
      );
      const coverRevision = accepted.artifactRevisions.find(
        (revision) => revision.artifactId === covers[0]!.artifactId,
      );
      assert.ok(coverRevision);
      const coverBlob = accepted.blobs.find(
        (blob) => blob.digest === coverRevision.blobDigest,
      );
      assert.equal(coverBlob?.mediaType, publication.cover.mediaType);
      assert.ok((coverBlob?.byteLength ?? 0) > 0);
      assert.ok((coverBlob?.byteLength ?? 0) <= 16 * 1024 * 1024);
      assert.deepEqual(accepted.currentRelatedEntities ?? [], []);
      assert.deepEqual(accepted.entityMentions ?? [], []);
      assert.deepEqual(accepted.relationships ?? [], []);
    }
    assert.equal(assetIds.size, 3);
    const enrichedProjection: unknown[] = [];
    for (const [
      publicationIndex,
      publication,
    ] of publicationSourceInputs.entries()) {
      const decisionIndex = 2 + publicationIndex * 7;
      const decision = jsonResult(
        results[decisionIndex],
      ) as unknown as SourceDecisionView;
      assert.equal(results[decisionIndex]!.exitCode, 0);
      assert.equal(decision.status, "running");
      assert.ok(
        decision.state === "awaiting-selection" ||
          decision.state === "awaiting-confirmation",
        `${publication.isbn} 来源决定没有进入可继续状态`,
      );
      assert.equal(
        decision.candidates.filter(
          ({ outcome, sourceIdentity, nativeAddress }) =>
            outcome === "accepted" &&
            sourceIdentity === publication.sourceIdentity &&
            nativeAddress === publication.productAddress,
        ).length,
        1,
      );

      const settled = jsonResult(
        results[decisionIndex + 1],
      ) as unknown as SourceDecisionView;
      assert.equal(results[decisionIndex + 1]!.exitCode, 0);
      assert.equal(settled.executionId, decision.executionId);
      assert.equal(settled.state, "awaiting-confirmation");
      assert.equal(settled.preview?.status, "awaiting-confirmation");
      assert.deepEqual(settled.preview?.projected.sourceAssociations, [
        {
          sourceIdentity: publication.sourceIdentity,
          nativeAddress: publication.productAddress,
        },
      ]);

      const retained = inspection(results[decisionIndex + 2]);
      assert.equal(results[decisionIndex + 2]!.exitCode, 0);
      assert.deepEqual(
        retained.sourceRecords.map(({ coverage }) => coverage.id),
        publication.expectedCoverage,
      );
      assert.ok(
        retained.sourceRecords.every(
          ({ sourceIdentity }) => sourceIdentity === publication.sourceIdentity,
        ),
        `${publication.isbn} 保留了其他来源的记录`,
      );
      assert.equal(
        retained.sourceRecords.filter(
          ({ nativeAddress }) => nativeAddress === publication.productAddress,
        ).length,
        1,
      );
      if (publication.sourceIdentity === "kadokawa-jp")
        assert.deepEqual(
          retained.sourceRecords.map(({ nativeAddress }) => nativeAddress),
          [
            `kadokawa-jp:isbn-search:${publication.isbn}`,
            publication.productAddress,
          ],
        );

      const applied = jsonResult(
        results[decisionIndex + 3],
      ) as unknown as AppliedPreviewView;
      assert.equal(results[decisionIndex + 3]!.exitCode, 0);
      assert.equal(applied.preview.status, "applied");
      assert.deepEqual(applied.preview.projected.sourceAssociations, [
        {
          sourceIdentity: publication.sourceIdentity,
          nativeAddress: publication.productAddress,
        },
      ]);

      const correction = jsonResult(
        results[decisionIndex + 4],
      ) as unknown as CorrectionSubjectView;
      assert.equal(results[decisionIndex + 4]!.exitCode, 0);
      assert.deepEqual(
        correction.current.map(({ sourceIdentity, nativeAddress }) => ({
          sourceIdentity,
          nativeAddress,
        })),
        [
          {
            sourceIdentity: publication.sourceIdentity,
            nativeAddress: publication.productAddress,
          },
        ],
      );
      assert.deepEqual(correction.historical, []);

      const refreshes = [
        inspection(results[decisionIndex + 5]),
        inspection(results[decisionIndex + 6]),
      ];
      for (const [refreshIndex, refresh] of refreshes.entries()) {
        assert.equal(results[decisionIndex + 5 + refreshIndex]!.exitCode, 0);
        assert.equal(refresh.execution.outcome, "accepted");
        assert.equal(
          refresh.accepted?.entity.id,
          scannedAssetId(results[1], publication.relativePath),
        );
        assert.deepEqual(
          refresh.accepted?.sourceAssociations.map(
            ({ sourceIdentity, nativeAddress }) => ({
              sourceIdentity,
              nativeAddress,
            }),
          ),
          [
            {
              sourceIdentity: publication.sourceIdentity,
              nativeAddress: publication.productAddress,
            },
          ],
        );
        assert.deepEqual(
          refresh.sourceRecords.map(({ coverage, nativeAddress }) => ({
            coverage: coverage.id,
            nativeAddress,
          })),
          [
            {
              coverage:
                publication.sourceIdentity === "kadokawa-jp"
                  ? "kadokawa-jp.detail"
                  : "taiwan-kadokawa.product-page",
              nativeAddress: publication.productAddress,
            },
          ],
        );
        const recordIds = new Set(refresh.sourceRecords.map(({ id }) => id));
        for (const [property, expected] of [
          ["book.isbn-13", publication.isbn],
          ["asset.title", publication.expectedTitle],
        ] as const) {
          const acceptedMetadata: Accepted["metadata"] =
            refresh.accepted?.metadata ?? [];
          const matchingFacts: Accepted["metadata"] = acceptedMetadata.filter(
            (fact) => fact.property === property && fact.value === expected,
          );
          assert.equal(matchingFacts.length, 1);
          assert.ok(
            matchingFacts[0]!.sourceRecordIds.length > 0,
            `${publication.isbn} 的 ${property} 缺少来源 provenance`,
          );
          assert.ok(
            matchingFacts[0]!.sourceRecordIds.some((id) => recordIds.has(id)),
            `${publication.isbn} 的 ${property} 没有引用本轮当前响应`,
          );
        }
        const primaryCovers =
          refresh.accepted?.artifactAssociations.filter(
            ({ role }) => role === "asset.primary-cover",
          ) ?? [];
        assert.equal(primaryCovers.length, 1);
        assert.equal(
          primaryCovers[0]!.observedArtifactPart?.locator,
          "pdf:page[1]",
        );
        assert.deepEqual(primaryCovers[0]!.sourceRecordIds ?? [], []);
      }
      assert.notDeepEqual(
        refreshes[0]!.sourceRecords.map(({ id }) => id),
        refreshes[1]!.sourceRecords.map(({ id }) => id),
        "重复刷新必须保留新的当前响应，而不是复用前一轮记录",
      );
      enrichedProjection.push(stablePublicationProjection(refreshes[1]!));
    }
    const stable = {
      initial: stableBusinessProjection(value),
      enriched: enrichedProjection,
    };
    if (context.mode === "source")
      sourceBusinessProjection.set(state.root.logicalRoot, stable);
    else if (sourceBusinessProjection.has(state.root.logicalRoot))
      assert.deepEqual(
        stable,
        sourceBusinessProjection.get(state.root.logicalRoot),
        "source/distribution PDF projection drifted",
      );
  },
  async teardown({ context }) {
    const key = stateKey(context);
    const state = stateByContext.get(key);
    if (state === undefined) return;
    try {
      const roots = [state.root];
      const after = await captureFixedCorpusSnapshots(
        roots,
        state.deepBefore !== undefined,
      );
      assert.deepEqual(
        after,
        state.before,
        "PDF fixed root changed during live journey",
      );
      if (state.deepBefore !== undefined) {
        const deepAfter = fixedCorpusContentDigestsFromSnapshots(roots, after);
        await assertFixedCorpusContentBaselineSubset(context, deepAfter);
        assert.deepEqual(deepAfter, state.deepBefore);
      }
    } finally {
      stateByContext.delete(key);
    }
  },
};

export default journey;
