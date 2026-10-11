import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  assertFixedCorpusContentBaselineSubset,
  captureFixedCorpusSnapshots,
  fixedCorpusContentDigestsFromSnapshots,
  type FixedCorpusContentDigest,
  type FixedCorpusRoot,
} from "../fixed-corpus.ts";
import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyResult,
} from "../journey.ts";

type AudioOracle = {
  readonly logicalRoot: string;
  readonly directory: string;
  readonly sourceNativeAddress: string;
  readonly title: string;
  readonly releaseDate: string;
  readonly language: string;
  readonly priceJpy: string;
  readonly circle: string;
  readonly circleSourceKey: string;
  readonly credits: {
    readonly voice: readonly string[];
    readonly scenario: readonly string[];
    readonly illustration: readonly string[];
    readonly author: readonly string[];
  };
  readonly reviewedSeries?: {
    readonly entityKind: string;
    readonly identityNamespace: string;
    readonly sourceKey: string;
    readonly label: string;
    readonly relationshipType: string;
    readonly relationshipRole: string;
    readonly officialCoverage: string;
    readonly officialIdField: string;
    readonly officialNameField: string;
    readonly officialWorkCount?: number;
  };
};

type DlsiteCorpusState = {
  readonly roots: readonly FixedCorpusRoot[];
  readonly deepBefore?: ReadonlyMap<string, FixedCorpusContentDigest>;
};

let works: readonly AudioOracle[] = [];
const baselines = new Map<
  string,
  readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly modifiedAtNanoseconds: string;
    readonly changedAtNanoseconds: string;
  }[]
>();
const stateByWorkDirectory = new Map<string, DlsiteCorpusState>();

function stateKey(context: Parameters<CliJourney["setup"]>[0]): string {
  return `${context.mode}:${context.workDir}`;
}

function currentState(
  context: Parameters<CliJourney["setup"]>[0],
): DlsiteCorpusState {
  const state = stateByWorkDirectory.get(stateKey(context));
  if (state === undefined) throw new Error("DLsite journey setup did not run");
  return state;
}

function corpusRoot(context: Parameters<CliJourney["setup"]>[0]): string {
  return path.resolve(
    context.packageRoot,
    "../..",
    ".scratch/acceptance-corpus",
  );
}

async function regularFileSignature(root: string) {
  return (await captureRawFilesystemSnapshot(root)).entries
    .filter((entry) => entry.kind === "regular-file")
    .map((entry) => ({
      path: entry.relativePath,
      byteLength: entry.byteLength,
      modifiedAtNanoseconds: entry.modifiedAtNanoseconds,
      changedAtNanoseconds: entry.changedAtNanoseconds,
    }));
}

const journey: CliJourney = {
  name: "dlsite-eight-live",
  source: { mode: "real" },
  modes: ["source", "distribution"],
  async setup(context) {
    const corpus = corpusRoot(context);
    const oracle = JSON.parse(
      await readFile(
        path.resolve(
          context.packageRoot,
          "../..",
          "fixtures/live-corpus/references/reviewed-oracle.json",
        ),
        "utf8",
      ),
    ) as {
      readonly reviews: {
        readonly dlsite: {
          readonly status: string;
          readonly reviewedAt: string;
          readonly reviewMethod: string;
        };
      };
      readonly audioWorks: readonly AudioOracle[];
    };
    assert.equal(
      oracle.reviews.dlsite.status,
      "reviewed-current-official-source",
    );
    assert.equal(oracle.reviews.dlsite.reviewedAt, "2026-08-29");
    assert.match(
      oracle.reviews.dlsite.reviewMethod,
      /Independently fetched and compared each current official DLsite product JSON and HTML page/u,
    );
    works = oracle.audioWorks;
    assert.equal(works.length, 8, "reviewed audio selection drifted");
    const roots: FixedCorpusRoot[] = [];
    for (const work of works) {
      const root = path.join(
        corpus,
        "assets/kikoeru/VoiceWork",
        work.directory,
      );
      assert.equal((await lstat(root)).isDirectory(), true);
      baselines.set(root, await regularFileSignature(root));
      roots.push({ logicalRoot: work.logicalRoot, directory: root });
    }
    const deepIntegrity = process.env.DIGITAL_DEEP_CORPUS_INTEGRITY === "1";
    const before = await captureFixedCorpusSnapshots(roots, deepIntegrity);
    const deepBefore = deepIntegrity
      ? fixedCorpusContentDigestsFromSnapshots(roots, before)
      : undefined;
    if (deepBefore !== undefined)
      await assertFixedCorpusContentBaselineSubset(context, deepBefore);
    stateByWorkDirectory.set(stateKey(context), {
      roots,
      ...(deepBefore === undefined ? {} : { deepBefore }),
    });
  },
  commands(context) {
    const corpus = corpusRoot(context);
    const data = context.productDataDirectory;
    return [
      ...works.map((work) => ({
        name: `register ${work.sourceNativeAddress} root`,
        args: [
          "library-create",
          `${work.sourceNativeAddress} 验收语料`,
          "--directory",
          path.join(corpus, "assets/kikoeru/VoiceWork", work.directory),
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      })),
      ...works.map((work, index) => ({
        name: `live refresh ${work.sourceNativeAddress}`,
        args: (results: readonly CliJourneyResult[]) => [
          "scan",
          registeredObservedRootId(results[index]),
          "--scope",
          ".",
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      })),
    ];
  },
  async assertions({ context, results: allResults }) {
    for (const registeredRoot of allResults.slice(0, works.length)) {
      assert.equal(registeredRoot.exitCode, 0, registeredRoot.stderr);
      registeredObservedRootId(registeredRoot);
    }
    const results = allResults.slice(works.length);
    assert.equal(results.length, works.length);
    const corpus = corpusRoot(context);
    const failures: {
      readonly sourceNativeAddress: string;
      readonly outcome?: string;
      readonly reason?: string;
      readonly exitCode: number;
    }[] = [];
    const sourcedEntityIds = new Map<string, string>();
    const sharedCircleIds = new Map<string, string>();
    let sawRj = false;
    let sawVj = false;
    let sawMultipleCredits = false;
    let sawLanguageEvidence = false;
    let sawSeriesEvidence = false;
    let sawBundledFiles = false;
    for (const [index, work] of works.entries()) {
      const result = results[index]!;
      const inspection = JSON.parse(result.stdout) as {
        readonly execution: {
          readonly outcome: string;
          readonly reason?: string;
          readonly snapshot: { readonly files: readonly unknown[] };
        };
        readonly sourceRecords: readonly {
          readonly id: string;
          readonly sourceIdentity: string;
          readonly coverage: { readonly id: string };
        }[];
        readonly accepted?: {
          readonly sourceAssociations: readonly {
            readonly nativeAddress: string;
          }[];
          readonly recognitionSourceAssociation?: {
            readonly nativeAddress: string;
          };
          readonly artifacts: readonly { readonly id: string }[];
          readonly artifactAssociations: readonly {
            readonly artifactId: string;
            readonly role: string;
            readonly sourceRecordIds?: readonly string[];
          }[];
          readonly metadata: readonly {
            readonly property: string;
            readonly value: string;
            readonly sourceRecordIds: readonly string[];
          }[];
          readonly entities?: readonly {
            readonly id: string;
            readonly kind: string;
            readonly label: string;
            readonly identityNamespace: string;
            readonly sourceKey: string;
            readonly sourceRecordIds: readonly string[];
          }[];
          readonly entityMentions?: readonly {
            readonly id: string;
            readonly field: string;
            readonly role: string;
            readonly label: string;
            readonly sourceRecordIds: readonly string[];
          }[];
          readonly entityResolutionDecisions?: readonly {
            readonly mentionId: string;
            readonly entityId: string;
            readonly sourceRecordIds: readonly string[];
          }[];
          readonly relationships?: readonly {
            readonly participants: readonly {
              readonly entityId: string;
              readonly role: string;
              readonly mentionIds?: readonly string[];
            }[];
            readonly type: string;
            readonly sourceRecordIds: readonly string[];
          }[];
        };
      };
      if (result.exitCode !== 0) {
        const failedRoot = path.join(
          corpus,
          "assets/kikoeru/VoiceWork",
          work.directory,
        );
        assert.deepEqual(
          await regularFileSignature(failedRoot),
          baselines.get(failedRoot),
        );
        failures.push({
          sourceNativeAddress: work.sourceNativeAddress,
          outcome: inspection.execution.outcome,
          ...(inspection.execution.reason === undefined
            ? {}
            : { reason: inspection.execution.reason }),
          exitCode: result.exitCode,
        });
        continue;
      }
      try {
        assert.equal(inspection.execution.outcome, "accepted");
        assert.equal(
          inspection.sourceRecords.every(
            (record) => record.sourceIdentity === "dlsite",
          ),
          true,
        );
        assert.deepEqual(
          inspection.sourceRecords.map((record) => record.coverage.id),
          ["dlsite.product-json", "dlsite.product-html"],
        );
        assert.ok(
          inspection.accepted?.recognitionSourceAssociation,
          `accepted DLsite work ${work.sourceNativeAddress} is missing its recognition source`,
        );
        assert.match(
          inspection.accepted.recognitionSourceAssociation.nativeAddress,
          new RegExp(`${work.sourceNativeAddress}\\.html$`, "u"),
        );
        sawRj ||= work.sourceNativeAddress.startsWith("RJ");
        sawVj ||= work.sourceNativeAddress.startsWith("VJ");
        const metadata = inspection.accepted?.metadata ?? [];
        const jsonRecordIds = new Set(
          inspection.sourceRecords
            .filter((record) => record.coverage.id === "dlsite.product-json")
            .map((record) => record.id),
        );
        const htmlRecordIds = new Set(
          inspection.sourceRecords
            .filter((record) => record.coverage.id === "dlsite.product-html")
            .map((record) => record.id),
        );
        assert.equal(jsonRecordIds.size, 1);
        assert.equal(htmlRecordIds.size, 1);
        for (const expected of [
          { property: "asset.title", value: work.title },
          { property: "asset.declared-language", value: work.language },
          { property: "dlsite.product.price-jpy", value: work.priceJpy },
        ]) {
          assert.equal(
            metadata.some(
              (item) =>
                item.property === expected.property &&
                item.value === expected.value &&
                item.sourceRecordIds.length === 1 &&
                item.sourceRecordIds.every((id) => jsonRecordIds.has(id)),
            ),
            true,
            `missing reviewed ${expected.property} for ${work.sourceNativeAddress}`,
          );
        }
        assert.equal(
          metadata.some(
            (item) =>
              item.property === "asset.release-date" &&
              item.value.startsWith(work.releaseDate) &&
              item.sourceRecordIds.length === 1 &&
              item.sourceRecordIds.every((id) => jsonRecordIds.has(id)),
          ),
          true,
          `missing reviewed release date for ${work.sourceNativeAddress}`,
        );
        const entities = inspection.accepted?.entities ?? [];
        const circle = entities.find(
          (entity) =>
            entity.identityNamespace === "dlsite.circle" &&
            entity.sourceKey === work.circleSourceKey &&
            entity.label === work.circle,
        );
        assert.notEqual(circle, undefined);
        assert.equal(
          circle?.sourceRecordIds.length === 1 &&
            circle.sourceRecordIds.every((id) => htmlRecordIds.has(id)),
          true,
          `circle did not cite reviewed HTML for ${work.sourceNativeAddress}`,
        );
        const priorCircle = sharedCircleIds.get(work.circle);
        if (priorCircle === undefined)
          sharedCircleIds.set(work.circle, circle!.id);
        else assert.equal(circle!.id, priorCircle);
        for (const [field, expectedCredits] of Object.entries(work.credits)) {
          const namespace = `dlsite.credit.${field}.${field}`;
          const actualCredits = entities
            .filter((entity) => entity.identityNamespace === namespace)
            .map((entity) => entity.label)
            .toSorted();
          assert.deepEqual(
            actualCredits,
            [...expectedCredits].toSorted(),
            `reviewed ${field} credits drifted for ${work.sourceNativeAddress}`,
          );
          for (const credit of expectedCredits) {
            const persona = entities.find(
              (entity) =>
                entity.identityNamespace === namespace &&
                entity.sourceKey === credit &&
                entity.label === credit &&
                entity.sourceRecordIds.length === 1 &&
                entity.sourceRecordIds.every((id) => htmlRecordIds.has(id)),
            );
            assert.notEqual(persona, undefined);
            const mention = inspection.accepted?.entityMentions?.find(
              (candidate) =>
                candidate.field === field &&
                candidate.role === field &&
                candidate.label === credit &&
                candidate.sourceRecordIds.length === 1 &&
                candidate.sourceRecordIds.every((id) => htmlRecordIds.has(id)),
            );
            assert.notEqual(mention, undefined);
            assert.equal(
              inspection.accepted?.entityResolutionDecisions?.some(
                (decision) =>
                  decision.mentionId === mention!.id &&
                  decision.entityId === persona!.id,
              ),
              true,
            );
            assert.equal(
              inspection.accepted?.relationships?.some((relationship) =>
                relationship.participants.some(
                  (participant) =>
                    participant.role === field &&
                    participant.entityId === persona!.id,
                ),
              ),
              true,
            );
          }
        }
        sawMultipleCredits ||= Object.values(work.credits).some(
          (credits) => credits.length > 1,
        );
        assert.equal(
          entities.some((entity) => entity.label.toUpperCase() === "N/A"),
          false,
        );
        assert.equal(
          JSON.stringify({
            entities,
            mentions: inspection.accepted?.entityMentions,
            relationships: inspection.accepted?.relationships,
          })
            .toUpperCase()
            .includes('"N/A"'),
          false,
        );
        for (const entity of entities) {
          const key = `${entity.identityNamespace}\u0000${entity.sourceKey}`;
          const prior = sourcedEntityIds.get(key);
          if (prior === undefined) sourcedEntityIds.set(key, entity.id);
          else assert.equal(entity.id, prior);
        }
        for (const mention of inspection.accepted?.entityMentions ?? []) {
          const resolution =
            inspection.accepted?.entityResolutionDecisions?.find(
              (decision) => decision.mentionId === mention.id,
            );
          assert.notEqual(resolution, undefined);
          assert.equal(
            inspection.accepted?.relationships?.some((relationship) =>
              relationship.participants.some(
                (participant) =>
                  participant.role === mention.role &&
                  participant.entityId === resolution!.entityId,
              ),
            ),
            true,
          );
        }
        const retainedIds = new Set(
          inspection.sourceRecords.map((record) => record.id),
        );
        const sourcedFacts = [
          ...metadata,
          ...(inspection.accepted?.entityMentions ?? []),
          ...(inspection.accepted?.entityResolutionDecisions ?? []),
          ...(inspection.accepted?.relationships ?? []),
        ];
        assert.equal(
          sourcedFacts.every(
            (fact) =>
              fact.sourceRecordIds.length > 0 &&
              fact.sourceRecordIds.every((id) => retainedIds.has(id)),
          ),
          true,
        );
        assert.equal(
          entities.every((entity) => entity.sourceRecordIds.length > 0),
          true,
        );
        sawLanguageEvidence = true;
        const seriesRelationships =
          inspection.accepted?.relationships?.filter((relationship) =>
            relationship.participants.some(
              (participant) => participant.role === "dlsite.series.member",
            ),
          ) ?? [];
        assert.equal(
          metadata.some((item) => item.property === "asset.series-position") &&
            seriesRelationships.length === 0,
          false,
        );
        sawSeriesEvidence ||= seriesRelationships.length > 0;
        if (work.reviewedSeries !== undefined) {
          const seriesEntity = entities.find(
            (entity) =>
              entity.kind === work.reviewedSeries?.entityKind &&
              entity.identityNamespace ===
                work.reviewedSeries.identityNamespace &&
              entity.sourceKey === work.reviewedSeries.sourceKey &&
              entity.label === work.reviewedSeries.label,
          );
          assert.ok(
            seriesEntity,
            `missing reviewed series Entity for ${work.sourceNativeAddress}`,
          );
          const officialRecordIds = new Set(
            inspection.sourceRecords
              .filter(
                (record) =>
                  record.coverage.id === work.reviewedSeries?.officialCoverage,
              )
              .map((record) => record.id),
          );
          assert.equal(officialRecordIds.size, 1);
          assert.ok(
            seriesRelationships.some(
              (relationship) =>
                relationship.type === work.reviewedSeries?.relationshipType &&
                relationship.participants.some(
                  (participant) =>
                    participant.entityId === seriesEntity.id &&
                    participant.role === work.reviewedSeries?.relationshipRole,
                ) &&
                relationship.sourceRecordIds.length === 1 &&
                relationship.sourceRecordIds.every((id) =>
                  officialRecordIds.has(id),
                ),
            ),
            `missing reviewed series relationship for ${work.sourceNativeAddress}`,
          );
        }
        const root = path.join(
          corpus,
          "assets/kikoeru/VoiceWork",
          work.directory,
        );
        const localFiles = baselines.get(root) ?? [];
        sawBundledFiles ||= localFiles.length > 1;
        assert.equal(
          inspection.execution.snapshot.files.length,
          localFiles.length,
        );
        assert.equal(
          inspection.accepted?.artifacts.length,
          localFiles.length + 1,
        );
        const associations = inspection.accepted?.artifactAssociations ?? [];
        assert.equal(
          associations.filter(
            (association) => association.role === "asset.material-delivered",
          ).length,
          localFiles.length,
        );
        assert.equal(
          associations.filter(
            (association) => association.role === "asset.primary-cover",
          ).length,
          1,
        );
        assert.equal(
          associations.every(
            (association) =>
              association.role === "asset.material-delivered" ||
              association.role === "asset.primary-cover",
          ),
          true,
        );
        assert.equal(
          new Set(associations.map((association) => association.artifactId))
            .size,
          inspection.accepted?.artifacts.length,
        );
        assert.deepEqual(await regularFileSignature(root), localFiles);
      } catch (error) {
        const failedRoot = path.join(
          corpus,
          "assets/kikoeru/VoiceWork",
          work.directory,
        );
        assert.deepEqual(
          await regularFileSignature(failedRoot),
          baselines.get(failedRoot),
        );
        failures.push({
          sourceNativeAddress: work.sourceNativeAddress,
          outcome: inspection.execution.outcome,
          reason: `reviewed-oracle assertion failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          exitCode: result.exitCode,
        });
      }
    }
    const state = currentState(context);
    if (state.deepBefore !== undefined) {
      const after = await captureFixedCorpusSnapshots(state.roots, true);
      assert.deepEqual(
        fixedCorpusContentDigestsFromSnapshots(state.roots, after),
        state.deepBefore,
        "DLsite live journey must not alter approved source bytes",
      );
    }
    if (failures.length > 0)
      throw new Error(
        `DLsite eight-work live acceptance failures:\n${JSON.stringify(failures, undefined, 2)}`,
      );
    assert.equal(sawRj, true, "eight-work gate did not exercise RJ addressing");
    assert.equal(sawVj, true, "eight-work gate did not exercise VJ addressing");
    assert.equal(
      sawMultipleCredits,
      true,
      "eight-work gate did not exercise multiple credited Personas",
    );
    assert.equal(
      sawLanguageEvidence,
      true,
      "eight-work gate did not retain language-edition evidence",
    );
    assert.equal(
      sawSeriesEvidence,
      true,
      "eight-work gate did not retain official series evidence",
    );
    assert.equal(
      sawBundledFiles,
      true,
      "eight-work gate did not exercise heterogeneous bundled files",
    );
  },
};

export default journey;
