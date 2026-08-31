import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    ".scratch/acceptance-corpus/references/RJ01668691.reviewed-oracle.json",
  );
}

const journey: CliJourney = {
  name: "asset-refresh",
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
    const data = path.join(context.workDir, "product-data");
    type IdOutput = {
      readonly execution?: { readonly id?: string };
      readonly changeImpactPreview?: { readonly id?: string };
      readonly accepted?: { readonly entity?: { readonly id?: string } };
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
    return [
      {
        name: "register live RJ01668691 corpus root",
        args: ["root-create", "RJ01668691 验收语料", source],
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
          jsonId(results, 0, (value) => value.accepted?.entity?.id),
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "directed rescrape previews RJ01497788",
        args: (results) => [
          "rescrape",
          registeredObservedRootId(results[0]),
          "https://www.dlsite.com/maniax/work/=/product_id/RJ01497788.html",
          "--scope",
          ".",
          "--source-identity",
          "dlsite",
          "--subject-id",
          jsonId(results, 0, (value) => value.accepted?.entity?.id),
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
          jsonId(results, 0, (value) => value.accepted?.entity?.id),
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "directed rescrape back to RJ01668691",
        args: (results) => [
          "rescrape",
          registeredObservedRootId(results[0]),
          "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
          "--scope",
          ".",
          "--source-identity",
          "dlsite",
          "--subject-id",
          jsonId(results, 0, (value) => value.accepted?.entity?.id),
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
    const accepted = JSON.parse(results[0]?.stdout ?? "") as {
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
      readonly accepted?: {
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
        readonly artifactRevisions: readonly unknown[];
        readonly artifactAssociations: readonly {
          readonly artifactId: string;
          readonly role: string;
        }[];
        readonly metadata: readonly {
          readonly property: string;
          readonly value: string;
          readonly sourceRecordIds: readonly string[];
        }[];
        readonly entities?: readonly {
          readonly kind: string;
          readonly identityNamespace: string;
          readonly label: string;
        }[];
        readonly relationships?: readonly {
          readonly role: string;
          readonly sourceRecordIds: readonly string[];
        }[];
        readonly recognitionExplanation: string;
      };
    };
    assert.equal(results[0]?.exitCode, 0, results[0]?.stderr);
    assert.equal(accepted.format, "temporary-asset-refresh-inspection/v1");
    assert.equal(accepted.unstable, true);
    assert.equal(accepted.execution.outcome, "accepted");
    assert.equal(
      accepted.execution.snapshot.files.length,
      oracle.selection.regularFileCount,
    );
    assert.deepEqual(
      accepted.sourceRecords.map((record) => record.coverage.id),
      ["dlsite.product-json", "dlsite.product-html"],
    );
    assert.equal(
      new Set(accepted.sourceRecords.map((record) => record.nativeAddress))
        .size,
      1,
    );
    assert.equal(accepted.accepted?.entity.kind, "digital-asset");
    assert.ok(
      accepted.accepted?.recognitionSourceAssociation,
      "accepted asset is missing its recognition source",
    );
    assert.match(
      accepted.accepted.recognitionSourceAssociation.nativeAddress,
      new RegExp(oracle.selection.identity, "u"),
    );
    assert.match(
      accepted.accepted?.recognitionExplanation ?? "",
      /精确来源地址/u,
    );
    assert.equal(
      accepted.accepted?.artifacts.length,
      accepted.execution.snapshot.files.length + 1,
    );
    assert.equal(
      accepted.accepted?.locations.filter(
        (location) => location.kind === "observed",
      ).length,
      accepted.execution.snapshot.files.length,
    );
    assert.equal(accepted.accepted?.artifactRevisions.length, 1);
    assert.match(accepted.accepted?.blobs[0]?.digest ?? "", /^[a-f0-9]{64}$/u);
    assert.match(accepted.accepted?.blobs[0]?.mediaType ?? "", /^image\//u);
    assert.deepEqual(
      accepted.accepted?.artifactAssociations
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
      accepted.accepted?.metadata.some(
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
        accepted.accepted?.metadata.some(
          (entry) =>
            entry.property === property &&
            entry.value === value &&
            entry.sourceRecordIds.length > 0,
        ),
        `missing reviewed metadata ${property}`,
      );
    }
    assert.ok(
      accepted.accepted?.entities?.some(
        (entity) =>
          entity.kind === "entity" &&
          entity.identityNamespace === "dlsite.circle" &&
          entity.label === oracle.projection.circle.label,
      ),
    );
    assert.ok(
      accepted.accepted?.entities?.some(
        (entity) =>
          entity.kind === "persona" &&
          entity.label === oracle.projection.credits.voice[0],
      ),
    );
    assert.deepEqual(
      accepted.accepted?.relationships
        ?.map((relationship) => relationship.role)
        .toSorted(),
      oracle.projection.relationshipRoles.toSorted(),
    );
    for (const record of accepted.sourceRecords) {
      assert.equal("body" in record, false);
      assert.equal("acquisition" in record, false);
    }

    const unchanged = JSON.parse(results[1]?.stdout ?? "") as {
      readonly execution: {
        readonly outcome: string;
        readonly reusedExecutionId?: string;
      };
      readonly sourceRecords: readonly unknown[];
    };
    assert.equal(results[1]?.exitCode, 0, results[1]?.stderr);
    assert.equal(unchanged.execution.outcome, "no-change");
    assert.ok(unchanged.execution.reusedExecutionId);
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
        readonly locations: readonly {
          readonly artifactId: string;
          readonly kind: string;
        }[];
        readonly artifactAssociations: readonly {
          readonly artifactId: string;
          readonly role: string;
        }[];
        readonly entities?: readonly { readonly id: string }[];
        readonly relationships?: readonly {
          readonly subjectId: string;
          readonly participantId: string;
          readonly type: string;
          readonly sourceRecordIds: readonly string[];
        }[];
      };
      readonly changeImpactPreview?: {
        readonly id: string;
        readonly status: string;
        readonly sourceAssociation: { readonly nativeAddress: string };
        readonly metadataCount: number;
        readonly entityCount: number;
        readonly mentionCount: number;
        readonly resolutionCount: number;
        readonly relationshipCount: number;
        readonly artifactCount: number;
        readonly primaryCoverArtifactId?: string;
        readonly blockingConditions: readonly string[];
      };
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
      accepted.sourceRecords.map((record) => record.id),
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
      replacement.changeImpactPreview?.sourceAssociation.nativeAddress ?? "",
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
    assert.equal(
      replacement.changeImpactPreview?.artifactCount,
      oracle.selection.regularFileCount + 1,
    );
    assert.ok(replacement.changeImpactPreview?.primaryCoverArtifactId);
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
    assert.ok(
      projected.accepted?.recognitionSourceAssociation,
      "applied identity projection is missing its recognition source",
    );
    assert.match(
      projected.accepted.recognitionSourceAssociation.nativeAddress,
      /RJ01497788/u,
    );
    assert.ok(
      projected.accepted?.metadata.every((assertion) =>
        assertion.sourceRecordIds.every((recordId) =>
          replacementSourceIds.has(recordId),
        ),
      ),
      "applied identity projection mixed old metadata facts",
    );
    const oldCoverId = accepted.accepted?.artifactAssociations.find(
      (association) => association.role === "asset.primary-cover",
    )?.artifactId;
    const newCoverId = projected.accepted?.artifactAssociations.find(
      (association) => association.role === "asset.primary-cover",
    )?.artifactId;
    assert.ok(newCoverId);
    assert.notEqual(newCoverId, oldCoverId);
    assert.equal(
      projected.accepted?.locations.filter(
        (location) => location.kind === "observed",
      ).length,
      oracle.selection.regularFileCount,
    );
    assert.equal(
      new Set(projected.accepted?.entities?.map((entity) => entity.id)).size,
      projected.accepted?.entities?.length,
    );
    assert.ok(
      projected.accepted?.relationships?.every(
        (relationship) =>
          relationship.subjectId === projected.accepted?.entity.id &&
          relationship.participantId !== projected.accepted?.entity.id &&
          relationship.sourceRecordIds.every((recordId) =>
            replacementSourceIds.has(recordId),
          ),
      ),
      "directed recognition invented a cross-asset relationship",
    );
    assert.ok(
      projected.accepted?.relationships?.some(
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
    assert.doesNotMatch(
      results[7]?.stderr ?? "",
      /正在识别目录|正在获取主封面/u,
    );

    const reverse = JSON.parse(results[8]?.stdout ?? "") as JourneyInspection;
    assert.equal(results[8]?.exitCode, 0, results[8]?.stderr);
    assert.match(
      reverse.changeImpactPreview?.sourceAssociation.nativeAddress ?? "",
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
    assert.ok(
      afterReject.accepted?.recognitionSourceAssociation,
      "rejected identity replacement lost its recognition source",
    );
    assert.match(
      afterReject.accepted.recognitionSourceAssociation.nativeAddress,
      /RJ01497788/u,
    );
    assert.deepEqual(
      afterReject.accepted?.metadata,
      replacementRefresh.accepted?.metadata,
    );
    assert.deepEqual(
      afterReject.accepted?.artifactAssociations,
      replacementRefresh.accepted?.artifactAssociations,
    );

    type StoredImpactProjection = {
      readonly sourceAssociation: { readonly nativeAddress: string };
      readonly relationships: readonly {
        readonly type: string;
        readonly role: string;
        readonly sourceRecordIds: readonly string[];
      }[];
    };
    type StoredImpactPreview = {
      readonly current: StoredImpactProjection;
      readonly projected: StoredImpactProjection;
    };
    const database = new DatabaseSync(
      path.join(context.workDir, "product-data", "catalogue.sqlite"),
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
      projection: StoredImpactProjection,
      expectedIdentity: RegExp,
      allowedSourceRecordIds: ReadonlySet<string>,
      forbiddenSourceRecordIds: ReadonlySet<string>,
    ) => {
      assert.match(
        projection.sourceAssociation.nativeAddress,
        expectedIdentity,
      );
      for (const relationship of projection.relationships) {
        assert.doesNotMatch(
          `${relationship.type} ${relationship.role}`,
          /bonus|supplement|特典|赠品|贈品/iu,
          "directed identity evidence invented a bonus or supplement relationship",
        );
        assert.ok(
          relationship.sourceRecordIds.length > 0 &&
            relationship.sourceRecordIds.every((id) =>
              allowedSourceRecordIds.has(id),
            ),
          "relationship mixed facts from another source identity",
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
      forwardPreview.current,
      /RJ01668691/u,
      knownSourceIds,
      replacementSourceIds,
    );
    assertSingleIdentityRelationships(
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
      reversePreview.current,
      /RJ01497788/u,
      knownReplacementSourceIds,
      reverseSourceIds,
    );
    assertSingleIdentityRelationships(
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
