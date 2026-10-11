import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AssetRefreshInspection } from "@digital/application";
import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyResult,
} from "../journey.ts";

async function tree(root: string): Promise<readonly string[]> {
  const snapshot = await captureRawFilesystemSnapshot(root, {
    contentDigests: true,
  });
  return snapshot.entries
    .filter((entry) => entry.relativePath !== ".")
    .map((entry) =>
      entry.kind === "directory"
        ? `${entry.relativePath}/`
        : `${entry.relativePath}:${entry.kind}:${entry.byteLength}:${entry.modifiedAtNanoseconds}:${entry.symbolicLinkTarget ?? ""}:${entry.contentDigest ?? ""}`,
    );
}

const baselines = new Map<string, readonly string[]>();

function corpusRoot(context: Parameters<CliJourney["setup"]>[0]): string {
  return path.resolve(
    context.packageRoot,
    "../..",
    ".scratch/acceptance-corpus/assets/kikoeru/VoiceWork/RJ01668691",
  );
}

function oraclePath(context: Parameters<CliJourney["setup"]>[0]): string {
  return path.resolve(
    context.packageRoot,
    "../..",
    "fixtures/live-corpus/references/RJ01668691.reviewed-oracle.json",
  );
}

const journey: CliJourney = {
  name: "asset-refresh",
  realCorpus: true,
  modes: ["source", "distribution"],
  async setup(context) {
    const source = corpusRoot(context);
    const details = await stat(source).catch(() => undefined);
    if (details?.isDirectory() !== true) {
      throw new Error(`required live acceptance corpus is missing: ${source}`);
    }
    await stat(oraclePath(context)).catch(() => {
      throw new Error("required reviewed RJ01668691 oracle is missing");
    });
    baselines.set(source, await tree(source));
  },
  commands(context) {
    const source = corpusRoot(context);
    const data = context.productDataDirectory;
    type IdOutput = {
      readonly execution?: { readonly id?: string };
      readonly changeImpactPreview?: { readonly id?: string };
      readonly itemResults?: readonly {
        readonly outcome?: string;
        readonly accepted?: { readonly entity?: { readonly id?: string } };
      }[];
    };
    const jsonId = (
      results: readonly CliJourneyResult[],
      index: number,
      selector: (value: IdOutput) => string | undefined,
    ) => {
      const result = results[index + 1];
      const value = selector(JSON.parse(result?.stdout ?? "{}") as IdOutput);
      if (value === undefined) {
        throw new Error(
          `command ${index + 1} did not expose its required id\nstdout: ${result?.stdout ?? ""}\nstderr: ${result?.stderr ?? ""}`,
        );
      }
      return value;
    };
    const acceptedEntityId = (value: IdOutput): string | undefined => {
      const acceptedItems = (value.itemResults ?? []).filter(
        (item) => item.outcome === "accepted",
      );
      assert.equal(
        acceptedItems.length,
        1,
        "fresh scan must expose exactly one accepted work item",
      );
      return acceptedItems[0]?.accepted?.entity?.id;
    };
    return [
      {
        name: "register live RJ01668691 corpus root",
        args: [
          "library-create",
          "RJ01668691 验收语料",
          "--directory",
          source,
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      },
      {
        name: "fresh live accepted scan",
        args: (results) => [
          "scan",
          registeredObservedRootId(results[0]),
          "--scope",
          ".",
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      },
      {
        name: "unchanged ordinary scan reuses accepted result",
        args: (results) => [
          "scan",
          registeredObservedRootId(results[0]),
          "--scope",
          ".",
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "refresh current DLsite metadata",
        args: (results) => [
          "refresh-metadata",
          jsonId(results, 0, acceptedEntityId),
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "directed rescrape previews RJ01497788",
        args: (results) => [
          "rescrape",
          registeredObservedRootId(results[0]),
          "dlsite",
          JSON.stringify({ product: "RJ01497788" }),
          "--scope",
          ".",
          "--subject-id",
          jsonId(results, 0, acceptedEntityId),
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      },
      {
        name: "show complete RJ01497788 impact preview",
        args: (results) => [
          "show-preview",
          jsonId(results, 3, (value) => value.changeImpactPreview?.id),
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "apply RJ01497788 impact preview",
        args: (results) => [
          "apply-preview",
          jsonId(results, 3, (value) => value.changeImpactPreview?.id),
          "--actor",
          "asset-refresh-live-reviewer",
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "inspect fully applied RJ01497788 projection",
        args: (results) => [
          "inspect",
          jsonId(results, 0, (value) => value.execution?.id),
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "refresh applied RJ01497788 metadata",
        args: (results) => [
          "refresh-metadata",
          jsonId(results, 0, acceptedEntityId),
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "directed rescrape back to RJ01668691",
        args: (results) => [
          "rescrape",
          registeredObservedRootId(results[0]),
          "dlsite",
          JSON.stringify({ product: "RJ01668691" }),
          "--scope",
          ".",
          "--subject-id",
          jsonId(results, 0, acceptedEntityId),
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      },
      {
        name: "show reverse identity impact preview",
        args: (results) => [
          "show-preview",
          jsonId(results, 8, (value) => value.changeImpactPreview?.id),
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "reject reverse identity impact preview",
        args: (results) => [
          "reject-preview",
          jsonId(results, 8, (value) => value.changeImpactPreview?.id),
          "--actor",
          "asset-refresh-live-reviewer",
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "inspect unchanged RJ01497788 identity after rejection",
        args: (results) => [
          "inspect",
          jsonId(results, 0, (value) => value.execution?.id),
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
    ];
  },
  async assertions({ context, results: allResults }) {
    assert.equal(allResults[0]?.exitCode, 0, allResults[0]?.stderr);
    registeredObservedRootId(allResults[0]);
    const results = allResults.slice(1);
    const oracle = JSON.parse(await readFile(oraclePath(context), "utf8")) as {
      readonly status: string;
      readonly selection: {
        readonly identity: string;
        readonly sourceNativeAddress: string;
        readonly regularFileCount: number;
      };
      readonly projection: {
        readonly title: string;
        readonly introduction: string;
        readonly releaseDate: string;
        readonly declaredLanguage: string;
        readonly contentClassification: string;
        readonly circle: { readonly label: string };
        readonly credits: {
          readonly voice: readonly string[];
          readonly scenario: readonly string[];
          readonly illustration: readonly string[];
        };
        readonly relationshipRoles: readonly string[];
      };
    };
    assert.equal(oracle.status, "official-source-and-filesystem-reviewed");
    type AcceptedProjection = {
      readonly entity: { readonly kind: string };
      readonly sourceAssociations: readonly {
        readonly nativeAddress: string;
      }[];
      readonly recognitionSourceAssociation?: {
        readonly nativeAddress: string;
      };
      readonly artifacts: readonly { readonly id: string }[];
      readonly locations: readonly { readonly kind: string }[];
      readonly blobs: readonly {
        readonly digest: string;
        readonly mediaType: string;
      }[];
      readonly artifactRevisions: readonly {
        readonly artifactId: string;
        readonly blobDigest: string;
        readonly producer: { readonly capabilityId: string };
      }[];
      readonly artifactAssociations: readonly {
        readonly artifactId: string;
        readonly role: string;
      }[];
      readonly metadata: readonly {
        readonly property: string;
        readonly value: string;
        readonly sourceRecordIds: readonly string[];
      }[];
      readonly currentRelatedEntities?: NonNullable<
        AssetRefreshInspection["accepted"]
      >["currentRelatedEntities"];
      readonly relationships?: readonly {
        readonly participants: readonly { readonly role: string }[];
        readonly sourceRecordIds: readonly string[];
      }[];
      readonly recognitionExplanation: string;
    };
    const initial = JSON.parse(results[0]?.stdout ?? "") as {
      readonly format: string;
      readonly unstable: boolean;
      readonly execution: {
        readonly outcome: string;
        readonly snapshot: { readonly files: readonly unknown[] };
      };
      readonly sourceRecords: readonly {
        readonly id: string;
        readonly coverage: { readonly id: string };
        readonly nativeAddress: string;
      }[];
      readonly itemResults?: readonly {
        readonly outcome?: string;
        readonly accepted?: AcceptedProjection;
      }[];
    };
    assert.equal(results[0]?.exitCode, 0, results[0]?.stderr);
    assert.equal(initial.format, "temporary-asset-refresh-inspection/v1");
    assert.equal(initial.unstable, true);
    assert.equal(initial.execution.outcome, "accepted");
    const acceptedItems = (initial.itemResults ?? []).filter(
      (item) => item.outcome === "accepted",
    );
    assert.equal(
      acceptedItems.length,
      1,
      "fresh scan must project exactly one accepted work item",
    );
    const accepted = acceptedItems[0]?.accepted;
    assert.ok(
      accepted,
      "fresh scan accepted work item is missing its projection",
    );
    assert.equal(
      initial.execution.snapshot.files.length,
      oracle.selection.regularFileCount,
    );
    assert.deepEqual(
      initial.sourceRecords.map((record) => record.coverage.id),
      ["dlsite.product-json", "dlsite.product-html"],
    );
    assert.equal(
      new Set(initial.sourceRecords.map((record) => record.nativeAddress)).size,
      1,
    );
    assert.equal(accepted.entity.kind, "digital-asset");
    assert.ok(
      accepted.recognitionSourceAssociation,
      "accepted asset is missing its recognition source",
    );
    assert.match(
      accepted.recognitionSourceAssociation.nativeAddress,
      new RegExp(oracle.selection.identity, "u"),
    );
    assert.match(accepted.recognitionExplanation, /精确来源地址/u);
    assert.equal(
      accepted.artifacts.length,
      initial.execution.snapshot.files.length + 1,
    );
    assert.equal(
      accepted.locations.filter((location) => location.kind === "observed")
        .length,
      initial.execution.snapshot.files.length,
    );
    assert.deepEqual(
      accepted.artifactRevisions
        .map(({ producer }) => producer.capabilityId)
        .toSorted(),
      ["dlsite.source-artifact-acquirer", "pdf.publication-inspection"],
    );
    const initialCoverId = accepted.artifactAssociations.find(
      ({ role }) => role === "asset.primary-cover",
    )?.artifactId;
    assert.ok(initialCoverId, "accepted asset is missing its primary cover");
    const initialCoverRevision = accepted.artifactRevisions.find(
      ({ artifactId }) => artifactId === initialCoverId,
    );
    assert.ok(
      initialCoverRevision,
      "accepted primary cover is missing its revision",
    );
    assert.match(initialCoverRevision.blobDigest, /^[a-f0-9]{64}$/u);
    assert.match(
      accepted.blobs.find(
        ({ digest }) => digest === initialCoverRevision.blobDigest,
      )?.mediaType ?? "",
      /^image\//u,
    );
    assert.deepEqual(
      accepted.artifactAssociations
        .map((association) => association.role)
        .toSorted(),
      [
        ...Array.from(
          { length: oracle.selection.regularFileCount },
          () => "asset.material-delivered",
        ),
        "asset.primary-cover",
      ],
    );
    assert.ok(
      accepted.metadata.some(
        (entry) =>
          entry.property === "asset.title" &&
          entry.value === oracle.projection.title,
      ),
    );
    for (const [property, value] of [
      ["asset.introduction", oracle.projection.introduction],
      ["asset.release-date", oracle.projection.releaseDate],
      ["asset.declared-language", oracle.projection.declaredLanguage],
      ["asset.content-classification", oracle.projection.contentClassification],
    ] as const) {
      assert.ok(
        accepted.metadata.some(
          (entry) =>
            entry.property === property &&
            entry.value === value &&
            entry.sourceRecordIds.length > 0,
        ),
        `missing reviewed metadata ${property}`,
      );
    }
    assert.ok(
      accepted.currentRelatedEntities?.some(
        (entity) =>
          entity.kind.status === "ordinary" &&
          entity.identityNamespace === "dlsite.circle" &&
          entity.label === oracle.projection.circle.label,
      ),
    );
    assert.ok(
      accepted.currentRelatedEntities?.some(
        (entity) =>
          entity.kind.status === "ordinary" &&
          entity.identityNamespace.startsWith("dlsite.credit.voice") &&
          entity.label === oracle.projection.credits.voice[0],
      ),
    );
    assert.deepEqual(
      accepted.relationships
        ?.flatMap((relationship) =>
          relationship.participants
            .filter(({ role }) => role !== "asset")
            .map((participant) => participant.role),
        )
        .toSorted(),
      oracle.projection.relationshipRoles.toSorted(),
    );
    for (const record of initial.sourceRecords) {
      assert.equal("body" in record, false);
      assert.equal("acquisition" in record, false);
    }

    const unchanged = JSON.parse(results[1]?.stdout ?? "") as {
      readonly execution: {
        readonly outcome: string;
      };
      readonly sourceRecords: readonly unknown[];
      readonly itemResults?: readonly { readonly outcome?: string }[];
    };
    assert.equal(results[1]?.exitCode, 0, results[1]?.stderr);
    assert.equal(unchanged.execution.outcome, "no-change");
    assert.deepEqual(
      (unchanged.itemResults ?? []).map(({ outcome }) => outcome),
      ["no-change"],
    );
    assert.equal(unchanged.sourceRecords.length, 0);
    assert.doesNotMatch(
      results[1]?.stderr ?? "",
      /正在获取官方来源|正在获取主封面/u,
    );

    type JourneyInspection = {
      readonly execution: {
        readonly id: string;
        readonly outcome: string;
        readonly selection: { readonly intent?: string };
      };
      readonly sourceRecords: readonly {
        readonly id: string;
        readonly nativeAddress: string;
        readonly coverage: { readonly id: string };
      }[];
      readonly accepted?: {
        readonly entity: { readonly id: string };
        readonly sourceAssociations: readonly {
          readonly nativeAddress: string;
        }[];
        readonly recognitionSourceAssociation?: {
          readonly nativeAddress: string;
        };
        readonly metadata: readonly {
          readonly property: string;
          readonly value: string;
          readonly sourceRecordIds: readonly string[];
        }[];
        readonly artifacts: readonly { readonly id: string }[];
        readonly blobs: readonly {
          readonly digest: string;
          readonly mediaType: string;
        }[];
        readonly artifactRevisions: readonly {
          readonly artifactId: string;
          readonly blobDigest: string;
        }[];
        readonly locations: readonly {
          readonly artifactId: string;
          readonly kind: string;
        }[];
        readonly artifactAssociations: readonly {
          readonly artifactId: string;
          readonly role: string;
        }[];
        readonly currentRelatedEntities?: NonNullable<
          AssetRefreshInspection["accepted"]
        >["currentRelatedEntities"];
        readonly relationships?: readonly {
          readonly participants: readonly {
            readonly entityId: string;
            readonly role: string;
          }[];
          readonly type: string;
          readonly sourceRecordIds: readonly string[];
        }[];
      };
      readonly itemResults?: readonly {
        readonly outcome?: string;
        readonly accepted?: JourneyInspection["accepted"];
      }[];
      readonly changeImpactPreview?: {
        readonly id: string;
        readonly status: string;
        readonly recognitionSourceAssociation?: {
          readonly nativeAddress: string;
        };
        readonly metadataCount: number;
        readonly entityCount: number;
        readonly mentionCount: number;
        readonly resolutionCount: number;
        readonly relationshipCount: number;
        readonly artifactCount: number;
        readonly blockingConditions: readonly string[];
      };
    };
    const acceptedItemProjection = (inspection: JourneyInspection) => {
      const items = (inspection.itemResults ?? []).filter(
        ({ outcome }) => outcome === "accepted",
      );
      assert.equal(items.length, 1, "inspection must expose one accepted item");
      const projection = items[0]?.accepted;
      assert.ok(projection, "accepted work item is missing its projection");
      return projection;
    };
    const metadataRefresh = JSON.parse(
      results[2]?.stdout ?? "",
    ) as JourneyInspection;
    assert.equal(results[2]?.exitCode, 0, results[2]?.stderr);
    assert.equal(metadataRefresh.execution.outcome, "accepted");
    assert.equal(
      metadataRefresh.execution.selection.intent,
      "metadata-refresh",
    );
    assert.ok(
      metadataRefresh.accepted?.recognitionSourceAssociation,
      "metadata refresh is missing its recognition source",
    );
    assert.match(
      metadataRefresh.accepted.recognitionSourceAssociation.nativeAddress,
      /RJ01668691/u,
    );
    assert.deepEqual(
      metadataRefresh.sourceRecords.map((record) => record.coverage.id),
      ["dlsite.product-json", "dlsite.product-html"],
    );
    const initialSourceIds = new Set(
      initial.sourceRecords.map((record) => record.id),
    );
    const refreshedSourceIds = new Set(
      metadataRefresh.sourceRecords.map((record) => record.id),
    );
    assert.ok(
      [...refreshedSourceIds].every(
        (recordId) => !initialSourceIds.has(recordId),
      ),
    );
    const knownSourceIds = new Set([
      ...initialSourceIds,
      ...refreshedSourceIds,
    ]);
    assert.ok(
      metadataRefresh.accepted?.metadata.every((assertion) =>
        assertion.sourceRecordIds.every((recordId) =>
          knownSourceIds.has(recordId),
        ),
      ),
      "metadata refresh included an assertion outside its known source lineages",
    );
    assert.doesNotMatch(
      results[2]?.stderr ?? "",
      /正在识别目录|正在获取主封面/u,
    );

    const replacement = JSON.parse(
      results[3]?.stdout ?? "",
    ) as JourneyInspection;
    assert.equal(results[3]?.exitCode, 0, results[3]?.stderr);
    assert.equal(replacement.execution.outcome, "proposal");
    assert.equal(
      replacement.execution.selection.intent,
      "directed-recognition",
    );
    assert.match(
      replacement.changeImpactPreview?.recognitionSourceAssociation
        ?.nativeAddress ?? "",
      /RJ01497788/u,
    );
    assert.equal(
      replacement.changeImpactPreview?.status,
      "awaiting-confirmation",
    );
    assert.equal(replacement.changeImpactPreview?.blockingConditions.length, 0);
    assert.ok((replacement.changeImpactPreview?.metadataCount ?? 0) > 0);
    assert.ok((replacement.changeImpactPreview?.entityCount ?? 0) > 0);
    assert.ok((replacement.changeImpactPreview?.mentionCount ?? 0) > 0);
    assert.ok((replacement.changeImpactPreview?.resolutionCount ?? 0) > 0);
    assert.ok((replacement.changeImpactPreview?.relationshipCount ?? 0) > 0);
    const replacementSourceIds = new Set(
      replacement.sourceRecords.map((record) => record.id),
    );

    const shownReplacement = JSON.parse(results[4]?.stdout ?? "") as {
      readonly preview: JourneyInspection["changeImpactPreview"];
    };
    assert.equal(results[4]?.exitCode, 0, results[4]?.stderr);
    assert.equal(
      shownReplacement.preview?.id,
      replacement.changeImpactPreview?.id,
    );
    assert.equal(shownReplacement.preview?.status, "awaiting-confirmation");
    const applied = JSON.parse(results[5]?.stdout ?? "") as {
      readonly preview: JourneyInspection["changeImpactPreview"];
    };
    assert.equal(results[5]?.exitCode, 0, results[5]?.stderr);
    assert.equal(applied.preview?.status, "applied");

    const projected = JSON.parse(results[6]?.stdout ?? "") as JourneyInspection;
    assert.equal(results[6]?.exitCode, 0, results[6]?.stderr);
    const projectedAccepted = acceptedItemProjection(projected);
    assert.equal(
      replacement.changeImpactPreview?.artifactCount,
      oracle.selection.regularFileCount,
      "identity preview must retain every current material artifact",
    );
    assert.ok(
      projectedAccepted.recognitionSourceAssociation,
      "applied identity projection is missing its recognition source",
    );
    assert.match(
      projectedAccepted.recognitionSourceAssociation.nativeAddress,
      /RJ01497788/u,
    );
    assert.ok(
      projectedAccepted.metadata.every((assertion) =>
        assertion.sourceRecordIds.every((recordId) =>
          replacementSourceIds.has(recordId),
        ),
      ),
      "applied identity projection mixed old metadata facts",
    );
    const oldCoverId = accepted.artifactAssociations.find(
      (association) => association.role === "asset.primary-cover",
    )?.artifactId;
    assert.ok(oldCoverId, "initial accepted asset is missing its source cover");
    const newCoverId = projectedAccepted.artifactAssociations.find(
      (association) => association.role === "asset.primary-cover",
    )?.artifactId;
    assert.equal(newCoverId, undefined);
    const materialArtifactIds = accepted.artifactAssociations
      .filter(({ role }) => role === "asset.material-delivered")
      .map(({ artifactId }) => artifactId)
      .toSorted();
    assert.deepEqual(
      projectedAccepted.artifactAssociations
        .filter(({ role }) => role === "asset.material-delivered")
        .map(({ artifactId }) => artifactId)
        .toSorted(),
      materialArtifactIds,
    );
    assert.equal(
      projectedAccepted.artifacts.length,
      oracle.selection.regularFileCount,
      "applied identity projection must contain only current materials",
    );
    assert.equal(
      projectedAccepted.locations.filter(
        (location) => location.kind === "observed",
      ).length,
      oracle.selection.regularFileCount,
      "applied identity projection must retain every observed material location",
    );
    assert.equal(
      new Set(
        projectedAccepted.currentRelatedEntities?.map((entity) => entity.id),
      ).size,
      projectedAccepted.currentRelatedEntities?.length,
    );
    assert.ok(
      projectedAccepted.relationships?.every(
        (relationship) =>
          relationship.participants.some(
            (participant) =>
              participant.entityId === projectedAccepted.entity.id &&
              participant.role === "asset",
          ) &&
          relationship.participants.some(
            (participant) =>
              participant.entityId !== projectedAccepted.entity.id,
          ) &&
          relationship.sourceRecordIds.every((recordId) =>
            replacementSourceIds.has(recordId),
          ),
      ),
      "directed recognition invented a cross-asset relationship",
    );
    assert.ok(
      projectedAccepted.relationships?.some(
        (relationship) => relationship.type === "asset.contribution",
      ),
      "directed recognition lost its contribution relationships",
    );
    const replacementRefresh = JSON.parse(
      results[7]?.stdout ?? "",
    ) as JourneyInspection;
    assert.equal(results[7]?.exitCode, 0, results[7]?.stderr);
    assert.ok(
      replacementRefresh.accepted?.recognitionSourceAssociation,
      "replacement metadata refresh is missing its recognition source",
    );
    assert.match(
      replacementRefresh.accepted.recognitionSourceAssociation.nativeAddress,
      /RJ01497788/u,
    );
    const refreshedCoverId =
      replacementRefresh.accepted.artifactAssociations.find(
        ({ role }) => role === "asset.primary-cover",
      )?.artifactId;
    assert.equal(refreshedCoverId, undefined);
    assert.deepEqual(
      replacementRefresh.accepted.artifactAssociations
        .filter(({ role }) => role === "asset.material-delivered")
        .map(({ artifactId }) => artifactId)
        .toSorted(),
      materialArtifactIds,
    );
    assert.equal(
      replacementRefresh.accepted.artifacts.length,
      oracle.selection.regularFileCount,
    );
    const replacementRefreshIds = new Set(
      replacementRefresh.sourceRecords.map((record) => record.id),
    );
    const knownReplacementSourceIds = new Set([
      ...replacementSourceIds,
      ...replacementRefreshIds,
    ]);
    assert.ok(
      replacementRefresh.accepted?.metadata.every((assertion) =>
        assertion.sourceRecordIds.every((recordId) =>
          knownReplacementSourceIds.has(recordId),
        ),
      ),
      "post-apply metadata refresh included an assertion outside its known source lineages",
    );
    assert.doesNotMatch(results[7]?.stderr ?? "", /正在识别目录/u);

    const reverse = JSON.parse(results[8]?.stdout ?? "") as JourneyInspection;
    assert.equal(results[8]?.exitCode, 0, results[8]?.stderr);
    assert.match(
      reverse.changeImpactPreview?.recognitionSourceAssociation
        ?.nativeAddress ?? "",
      /RJ01668691/u,
    );
    const shownReverse = JSON.parse(results[9]?.stdout ?? "") as {
      readonly preview: JourneyInspection["changeImpactPreview"];
    };
    assert.equal(shownReverse.preview?.status, "awaiting-confirmation");
    const rejected = JSON.parse(results[10]?.stdout ?? "") as {
      readonly preview: JourneyInspection["changeImpactPreview"];
    };
    assert.equal(results[10]?.exitCode, 0, results[10]?.stderr);
    assert.equal(rejected.preview?.status, "rejected");
    const afterReject = JSON.parse(
      results[11]?.stdout ?? "",
    ) as JourneyInspection;
    assert.equal(results[11]?.exitCode, 0, results[11]?.stderr);
    const afterRejectAccepted = acceptedItemProjection(afterReject);
    assert.ok(
      afterRejectAccepted.recognitionSourceAssociation,
      "rejected identity replacement lost its recognition source",
    );
    assert.match(
      afterRejectAccepted.recognitionSourceAssociation.nativeAddress,
      /RJ01497788/u,
    );
    const {
      sourceArtifactCandidates: _refreshCandidates,
      ...refreshedProjection
    } = replacementRefresh.accepted as typeof replacementRefresh.accepted & {
      readonly sourceArtifactCandidates?: unknown;
    };
    const {
      sourceArtifactCandidates: _rejectedCandidates,
      ...rejectedProjection
    } = afterRejectAccepted as typeof afterRejectAccepted & {
      readonly sourceArtifactCandidates?: unknown;
    };
    assert.deepEqual(rejectedProjection, refreshedProjection);

    type StoredImpactProjection = {
      readonly recognitionSourceAssociation: {
        readonly nativeAddress: string;
      };
      readonly relationships: readonly {
        readonly type: string;
        readonly participants: readonly { readonly role: string }[];
        readonly sourceRecordIds: readonly string[];
      }[];
    };
    type StoredImpactPreview = {
      readonly current: StoredImpactProjection;
      readonly projected: StoredImpactProjection;
    };
    const database = new DatabaseSync(
      path.join(context.productDataDirectory, "catalogue.sqlite"),
      { readOnly: true },
    );
    const storedPreview = (id: string) => {
      const row = database
        .prepare("SELECT preview_json FROM change_impact_previews WHERE id = ?")
        .get(id) as { readonly preview_json: string } | undefined;
      assert.ok(row, `missing durable Change Impact Preview ${id}`);
      return JSON.parse(row.preview_json) as StoredImpactPreview;
    };
    const assertSingleIdentityRelationships = (
      label: string,
      projection: StoredImpactProjection,
      expectedIdentity: RegExp,
      allowedSourceRecordIds: ReadonlySet<string>,
      forbiddenSourceRecordIds: ReadonlySet<string>,
    ) => {
      assert.match(
        projection.recognitionSourceAssociation.nativeAddress,
        expectedIdentity,
      );
      for (const relationship of projection.relationships) {
        assert.doesNotMatch(
          `${relationship.type} ${relationship.participants.map((item) => item.role).join(" ")}`,
          /bonus|supplement|特典|赠品|贈品/iu,
          "directed identity evidence invented a bonus or supplement relationship",
        );
        assert.ok(
          relationship.sourceRecordIds.length > 0 &&
            relationship.sourceRecordIds.every((id) =>
              allowedSourceRecordIds.has(id),
            ),
          `${label} relationship mixed facts from another source identity`,
        );
        assert.equal(
          relationship.sourceRecordIds.some((id) =>
            forbiddenSourceRecordIds.has(id),
          ),
          false,
          "relationship simultaneously connected both directed source identities",
        );
      }
    };
    const forwardPreview = storedPreview(
      replacement.changeImpactPreview?.id ?? "",
    );
    assertSingleIdentityRelationships(
      "forward current",
      forwardPreview.current,
      /RJ01668691/u,
      knownSourceIds,
      replacementSourceIds,
    );
    assertSingleIdentityRelationships(
      "forward projected",
      forwardPreview.projected,
      /RJ01497788/u,
      replacementSourceIds,
      refreshedSourceIds,
    );
    const reverseSourceIds = new Set(
      reverse.sourceRecords.map((record) => record.id),
    );
    const reversePreview = storedPreview(reverse.changeImpactPreview?.id ?? "");
    assertSingleIdentityRelationships(
      "reverse current",
      reversePreview.current,
      /RJ01497788/u,
      knownReplacementSourceIds,
      reverseSourceIds,
    );
    assertSingleIdentityRelationships(
      "reverse projected",
      reversePreview.projected,
      /RJ01668691/u,
      reverseSourceIds,
      replacementRefreshIds,
    );
    database.close();

    const source = corpusRoot(context);
    assert.deepEqual(await tree(source), baselines.get(source));
  },
};

export default journey;
