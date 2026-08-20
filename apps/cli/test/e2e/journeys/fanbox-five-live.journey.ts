import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyResult,
} from "../journey.ts";

type PostOracle = {
  readonly logicalRoot: string;
  readonly directoryDate: string;
  readonly sourceNativeAddress: string;
  readonly title: string;
  readonly publishedDatetime: string;
  readonly postType: string;
  readonly creatorId: string;
  readonly entitlement: "available" | "restricted";
  readonly hasOfficialCover: boolean;
  readonly articleFileCount?: number;
};

let posts: readonly PostOracle[] = [];
let directories: readonly string[] = [];
const baselines = new Map<string, readonly string[]>();

function corpusRoot(context: Parameters<CliJourney["setup"]>[0]): string {
  return path.resolve(
    context.packageRoot,
    "../..",
    ".scratch/acceptance-corpus",
  );
}

async function entrySignature(root: string): Promise<readonly string[]> {
  return (await captureRawFilesystemSnapshot(root)).entries
    .filter((entry) => entry.relativePath !== ".")
    .map(
      (entry) =>
        `${entry.relativePath}:${entry.kind === "directory" ? "d" : entry.kind === "regular-file" ? "f" : entry.kind === "symbolic-link" ? "l" : "o"}:${entry.byteLength}:${entry.modifiedAtNanoseconds}:${entry.changedAtNanoseconds}:${entry.symbolicLinkTarget ?? ""}`,
    );
}

function acceptedAssetId(result: CliJourneyResult | undefined): string {
  const output = JSON.parse(result?.stdout ?? "{}") as {
    readonly accepted?: { readonly entity?: { readonly id?: string } };
  };
  const id = output.accepted?.entity?.id;
  if (id === undefined)
    throw new Error(`expected accepted asset id in ${result?.stdout ?? ""}`);
  return id;
}

const journey: CliJourney = {
  name: "fanbox-five-live",
  modes: ["source", "distribution"],
  async setup(context) {
    const corpus = corpusRoot(context);
    const oracle = JSON.parse(
      await readFile(
        path.join(corpus, "references/reviewed-oracle.seed.json"),
        "utf8",
      ),
    ) as { readonly creatorPosts: readonly PostOracle[] };
    posts = oracle.creatorPosts;
    assert.equal(posts.length, 5, "reviewed creator-post selection drifted");
    directories = posts.map((post) => {
      const directory = path.join(corpus, "assets", post.logicalRoot);
      return directory;
    });
    for (const directory of directories) {
      assert.equal((await lstat(directory)).isDirectory(), true);
      baselines.set(directory, await entrySignature(directory));
    }
  },
  commands(context) {
    const data = path.join(context.workDir, "product-data");
    const cookieFile = path.resolve(
      context.packageRoot,
      "../..",
      "docs/fanbox.json",
    );
    const productEnv = {
      DIGITAL_PRODUCT_DATA: data,
    };
    return [
      {
        name: "import FANBOX creator connection",
        args: ["fanbox-connection-import", "customudon", cookieFile],
        env: productEnv,
        haltOnFailure: true,
      },
      ...directories.map((directory, index) => ({
        name: `register FANBOX post root ${posts[index]!.sourceNativeAddress}`,
        args: [
          "root-create",
          `FANBOX ${posts[index]!.sourceNativeAddress}`,
          directory,
        ],
        env: productEnv,
        haltOnFailure: true,
      })),
      ...directories.map((_directory, index) => ({
        name: `live accept FANBOX post ${posts[index]!.sourceNativeAddress}`,
        args: (results: readonly CliJourneyResult[]) => [
          "scan",
          registeredObservedRootId(results[index + 1]),
          "--scope",
          ".",
          "--json",
        ],
        env: productEnv,
        haltOnFailure: true,
      })),
      ...directories.map((_directory, index) => ({
        name: `live metadata refresh FANBOX post ${posts[index]!.sourceNativeAddress}`,
        args: (results: readonly CliJourneyResult[]) => [
          "refresh-metadata",
          acceptedAssetId(results[directories.length + 1 + index]),
          "--json",
        ],
        env: productEnv,
      })),
    ];
  },
  async assertions({ results: allResults }) {
    const importedConnection = allResults[0];
    if (importedConnection === undefined)
      throw new Error("FANBOX live journey did not run connection import");
    assert.equal(importedConnection.exitCode, 0, importedConnection.stderr);
    assert.doesNotMatch(
      `${importedConnection.stdout}\n${importedConnection.stderr}`,
      /FANBOXSESSID|cf_clearance|docs[\\/]fanbox\.json|cookie/iu,
      "private FANBOX configuration leaked through connection import output",
    );
    const registeredRoots = allResults.slice(1, directories.length + 1);
    for (const registeredRoot of registeredRoots) {
      assert.equal(registeredRoot.exitCode, 0, registeredRoot.stderr);
      registeredObservedRootId(registeredRoot);
    }
    const results = allResults.slice(directories.length + 1);
    assert.equal(results.length, posts.length * 2);
    const failures: {
      readonly sourceNativeAddress: string;
      readonly outcome?: string;
      readonly reason?: string;
      readonly retainedCoverage: readonly string[];
      readonly exitCode: number;
    }[] = [];
    for (const result of results) {
      assert.doesNotMatch(
        `${result.stdout}\n${result.stderr}`,
        /FANBOXSESSID|cf_clearance|docs[\\/]fanbox\.json|cookie/iu,
        "private FANBOX configuration leaked through delivery output",
      );
    }
    for (const [resultIndex, result] of results.entries()) {
      const index = resultIndex % posts.length;
      const post = posts[index]!;
      const operation =
        resultIndex < posts.length ? "initial acceptance" : "metadata refresh";
      const inspection = JSON.parse(result.stdout) as {
        readonly execution: {
          readonly outcome: string;
          readonly reason?: string;
          readonly dispositions?: readonly {
            readonly key: string;
            readonly reason?: string;
          }[];
        };
        readonly sourceRecords: readonly {
          readonly id: string;
          readonly sourceIdentity: string;
          readonly coverage: { readonly id: string };
        }[];
        readonly accepted?: {
          readonly sourceAssociation: { readonly nativeAddress: string };
          readonly artifacts: readonly { readonly id: string }[];
          readonly artifactAssociations: readonly {
            readonly artifactId: string;
            readonly role: string;
            readonly sourceRecordIds?: readonly string[];
          }[];
          readonly locations: readonly {
            readonly artifactId: string;
            readonly kind: string;
          }[];
          readonly metadata: readonly {
            readonly property: string;
            readonly value: string;
            readonly sourceRecordIds: readonly string[];
          }[];
          readonly entities?: readonly {
            readonly sourceKey: string;
            readonly sourceRecordIds: readonly string[];
          }[];
          readonly entityMentions?: readonly {
            readonly sourceRecordIds: readonly string[];
          }[];
          readonly entityResolutionDecisions?: readonly {
            readonly sourceRecordIds: readonly string[];
          }[];
          readonly relationships?: readonly {
            readonly sourceRecordIds: readonly string[];
          }[];
        };
      };
      const coverage = inspection.sourceRecords.map(
        (record) => record.coverage.id,
      );
      const collectionDiagnosis = inspection.execution.dispositions?.find(
        (item) => item.key.includes("official"),
      )?.reason;
      try {
        assert.equal(result.exitCode, 0);
        assert.equal(inspection.execution.outcome, "accepted");
        assert.equal(
          inspection.sourceRecords.every(
            (record) => record.sourceIdentity === "fanbox",
          ),
          true,
        );
        assert.deepEqual(coverage, [
          "fanbox.creator-post-summaries",
          "fanbox.post-detail",
        ]);
        assert.equal(
          inspection.accepted?.sourceAssociation.nativeAddress,
          `https://www.fanbox.cc/@${post.creatorId}/posts/${post.sourceNativeAddress}`,
        );
        for (const [property, value] of [
          ["asset.title", post.title],
          ["asset.publication-datetime", post.publishedDatetime],
          ["fanbox.post.form", post.postType],
          ["fanbox.post.entitlement", post.entitlement],
        ])
          assert.equal(
            inspection.accepted?.metadata.some(
              (item) => item.property === property && item.value === value,
            ),
            true,
            `${operation} did not prove ${property}`,
          );
        if (post.entitlement === "available")
          assert.equal(
            inspection.accepted?.metadata.some(
              (item) => item.property === "asset.body" && item.value.length > 0,
            ),
            true,
            `${operation} did not retain the accessible post body`,
          );
        if (post.articleFileCount !== undefined)
          assert.equal(
            inspection.accepted?.metadata.filter(
              (item) => item.property === "fanbox.attachment.name",
            ).length,
            post.articleFileCount,
            `${operation} attachment listing drifted`,
          );
        assert.equal(
          inspection.accepted?.entities?.some(
            (entity) => entity.sourceKey === post.creatorId,
          ),
          true,
        );
        const sourcedFacts = [
          ...(inspection.accepted?.metadata ?? []),
          ...(inspection.accepted?.entityMentions ?? []),
          ...(inspection.accepted?.entityResolutionDecisions ?? []),
          ...(inspection.accepted?.relationships ?? []),
        ];
        assert.equal(
          sourcedFacts.every((fact) => fact.sourceRecordIds.length > 0),
          true,
        );
        assert.equal(
          inspection.accepted?.entities?.every(
            (entity) => entity.sourceRecordIds.length > 0,
          ),
          true,
        );
        const observedArtifactIds = new Set(
          inspection.accepted?.locations
            .filter((location) => location.kind === "observed")
            .map((location) => location.artifactId) ?? [],
        );
        const observedAssociations =
          inspection.accepted?.artifactAssociations.filter((association) =>
            observedArtifactIds.has(association.artifactId),
          ) ?? [];
        assert.equal(
          observedAssociations.every(
            (association) => association.role === "asset.material-delivered",
          ),
          true,
        );
        const managedArtifactIds = new Set(
          inspection.accepted?.locations
            .filter((location) => location.kind === "managed")
            .map((location) => location.artifactId) ?? [],
        );
        const sourceArtifactAssociations =
          inspection.accepted?.artifactAssociations.filter(
            (association) => (association.sourceRecordIds?.length ?? 0) > 0,
          ) ?? [];
        assert.equal(
          sourceArtifactAssociations.every(
            (association) =>
              association.role === "asset.primary-cover" &&
              managedArtifactIds.has(association.artifactId),
          ),
          true,
          `${operation} managed an unrequested source artifact`,
        );
        assert.equal(
          sourceArtifactAssociations.some((association) =>
            association.role.startsWith("fanbox.attachment."),
          ),
          false,
          `${operation} turned an attachment listing into an Artifact`,
        );
        const primaryCoverAssociations = sourceArtifactAssociations.filter(
          (association) => association.role === "asset.primary-cover",
        );
        assert.equal(
          primaryCoverAssociations.length,
          post.hasOfficialCover ? 1 : 0,
        );
        assert.equal(
          observedArtifactIds.size,
          (baselines.get(directories[index]!) ?? []).filter((entry) =>
            entry.includes(":f:"),
          ).length,
        );
      } catch (error) {
        failures.push({
          sourceNativeAddress: post.sourceNativeAddress,
          outcome: inspection.execution.outcome,
          reason: `${operation}: ${
            error instanceof Error ? error.message : String(error)
          }${
            collectionDiagnosis === undefined
              ? ""
              : `; official collection: ${collectionDiagnosis}`
          }`,
          retainedCoverage: coverage,
          exitCode: result.exitCode,
        });
      }
      assert.deepEqual(
        await entrySignature(directories[index]!),
        baselines.get(directories[index]!),
      );
    }
    if (failures.length > 0)
      throw new Error(
        `FANBOX five-post live acceptance failures:\n${JSON.stringify(failures, undefined, 2)}`,
      );
  },
};

export default journey;
