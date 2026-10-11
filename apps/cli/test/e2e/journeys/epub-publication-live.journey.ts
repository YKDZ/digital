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
  type CliJourneyContext,
  type CliJourneyResult,
} from "../journey.ts";

const ownerTicket =
  "v1-live-acceptance/issues/03-epub-publication-live-gate.md";
export const approvedEpubOracleSliceDigest =
  "4852cefe20b121df4547307a7a28fbc49d3bb8fd95ae860e9e7a611a01ce179e";
const maximumOfficialResponseBytes = 2 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function epubOracleSlice(rawOracle: unknown): unknown {
  const oracle = record(rawOracle);
  const reviews = record(oracle?.reviews);
  const groups = Array.isArray(oracle?.dedicatedIntegrationOwnershipGroups)
    ? oracle.dedicatedIntegrationOwnershipGroups
    : [];
  return {
    reviews: { epub: reviews?.epub },
    dedicatedIntegrationOwnershipGroups: groups.filter(
      (group) => record(group)?.ownerTicket === ownerTicket,
    ),
    epubPublications: oracle?.epubPublications,
  };
}

/** 在任何真实媒体或 CLI 动作前固定本 gate 自己审核过的 oracle 语义。 */
export function assertApprovedEpubOracleSlice(rawOracle: unknown): void {
  const digest = createHash("sha256")
    .update(JSON.stringify(epubOracleSlice(rawOracle)))
    .digest("hex");
  assert.equal(
    digest,
    approvedEpubOracleSliceDigest,
    "EPUB reviewed oracle slice digest drifted",
  );
}

function validIsbn13(value: string): boolean {
  if (!/^(?:97[89])\d{10}$/u.test(value)) return false;
  const sum = Array.from(value)
    .slice(0, 12)
    .reduce(
      (total, digit, index) =>
        total + Number(digit) * (index % 2 === 0 ? 1 : 3),
      0,
    );
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

function strictIsbn13(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match =
    /^(?:ISBN(?:-13)?(?:\s*:\s*|\s+))?(97[89](?:[ -]?\d){10})$/iu.exec(value);
  const normalized = match?.[1]?.replaceAll(/[ -]/gu, "");
  return normalized !== undefined && validIsbn13(normalized)
    ? normalized
    : undefined;
}

type OfficialMetadata = {
  readonly property: string;
  readonly value: string;
};

export type CanonicalOfficialProjection = {
  readonly isbn: string;
  readonly sourceAddress: string;
  readonly metadata: readonly OfficialMetadata[];
  readonly digest: string;
};

function strings(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) =>
    typeof item === "string" && item.trim().length > 0 ? [item.trim()] : [],
  );
}

function comparableMetadata(item: OfficialMetadata): string {
  return `${item.property}\u0000${item.value}`;
}

function canonicalSourceAddress(isbn: string): string {
  const query = new URLSearchParams({
    inst: "886NCL_NBINET",
    vid: "886NCL_NBINET:NBINET",
    lang: "zh-tw",
    q: `isbn,exact,${isbn}`,
    scope: "MyInstitution",
    tab: "NBINET",
    skipDelivery: "Y",
  });
  return `https://nbinet.primo.exlibrisgroup.com/discovery/search?${query}`;
}

/** 验证 transient NBINet bytes，并只保留确定性的完整书目投影。 */
export function canonicalExactOfficialResponse(
  bytes: Uint8Array,
  isbn: string,
  sourceAddress: string,
): CanonicalOfficialProjection {
  assert.ok(
    bytes.byteLength > 0 && bytes.byteLength <= maximumOfficialResponseBytes,
    "NBINet exact response is outside the bounded body size",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("NBINet exact response is not valid JSON");
  }
  const docs = record(parsed)?.docs;
  const documents = Array.isArray(docs) ? docs : [];
  assert.equal(
    documents.length,
    1,
    "NBINet exact response must contain exactly one document",
  );
  const document = record(documents[0]);
  const pnx = record(document?.pnx);
  const identifiers = record(pnx?.addata)?.isbn;
  const exactMatches = (Array.isArray(identifiers) ? identifiers : [])
    .map(strictIsbn13)
    .filter((value) => value === isbn);
  assert.equal(
    exactMatches.length,
    1,
    "NBINet exact document must contain the strict target ISBN exactly once",
  );
  assert.equal(
    sourceAddress,
    canonicalSourceAddress(isbn),
    "NBINet source address must be the canonical exact ISBN address",
  );
  const display = record(pnx?.display);
  const metadata = [
    { property: "book.isbn-13", value: isbn },
    ...strings(display?.title).map((value) => ({
      property: "asset.title",
      value,
    })),
    ...strings(display?.creator).map((value) => ({
      property: "book.contributor",
      value,
    })),
    ...strings(display?.publisher).map((value) => ({
      property: "book.publisher",
      value,
    })),
    ...strings(display?.creationdate).map((value) => ({
      property: "book.publication-date",
      value,
    })),
    ...strings(display?.language).map((value) => ({
      property: "asset.declared-language",
      value,
    })),
  ].toSorted((left, right) =>
    comparableMetadata(left).localeCompare(comparableMetadata(right)),
  );
  const canonical = { isbn, sourceAddress, metadata };
  return {
    ...canonical,
    digest: createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex"),
  };
}

export function digestExactOfficialResponse(
  bytes: Uint8Array,
  isbn: string,
  sourceAddress: string,
): string {
  return canonicalExactOfficialResponse(bytes, isbn, sourceAddress).digest;
}

type FormatFactOracle = {
  readonly property: string;
  readonly value: string;
  readonly locator: string;
};

type OfficialOracle = {
  readonly isbn: string;
  readonly requestAddress: string;
  readonly sourceAddress: string;
  readonly metadata: readonly OfficialMetadata[];
};

type PublicationOracle = {
  readonly logicalRoot: string;
  readonly revision: {
    readonly digest: string;
    readonly mediaType: string;
    readonly byteLength: number;
  };
  readonly formatFacts: readonly FormatFactOracle[];
  readonly cover: { readonly locator: string; readonly mediaType: string };
  readonly official?: OfficialOracle;
};

type JourneyState = {
  readonly roots: readonly FixedCorpusRoot[];
  readonly publications: readonly PublicationOracle[];
  readonly before: ReadonlyMap<string, RawFilesystemSnapshot>;
  readonly officialProjections: ReadonlyMap<
    string,
    CanonicalOfficialProjection
  >;
  readonly deepBefore?: ReadonlyMap<string, FixedCorpusContentDigest>;
};

const stateByContext = new Map<string, JourneyState>();

function stateKey(context: CliJourneyContext): string {
  return `${context.mode}\u0000${context.workDir}`;
}

function currentState(context: CliJourneyContext): JourneyState {
  const state = stateByContext.get(stateKey(context));
  if (state === undefined)
    throw new Error("EPUB publication live journey setup did not run");
  return state;
}

function corpusRoot(context: CliJourneyContext): string {
  return path.resolve(context.packageRoot, "../..", "fixtures/live-corpus");
}

function exactRootSet(actual: readonly string[], expected: readonly string[]) {
  assert.equal(new Set(actual).size, actual.length);
  assert.deepEqual([...actual].toSorted(), [...expected].toSorted());
}

function inspection(
  result: CliJourneyResult | undefined,
): AssetRefreshInspection {
  return JSON.parse(result?.stdout ?? "{}") as AssetRefreshInspection;
}

function acceptedProjection(value: AssetRefreshInspection) {
  const items = value.itemResults ?? [];
  assert.equal(items.length, 1, "one EPUB root must yield one work item");
  assert.equal(items[0]!.relativePaths.length, 1);
  assert.equal(items[0]!.outcome, "accepted");
  const accepted = items[0]!.accepted ?? value.accepted;
  assert.ok(accepted, "EPUB work item must expose its accepted projection");
  return accepted;
}

function assertFormatFact(
  accepted: ReturnType<typeof acceptedProjection>,
  expected: FormatFactOracle,
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
    `missing exact EPUB fact ${expected.property}:${expected.value}`,
  );
  assert.deepEqual(matches[0]!.sourceRecordIds, []);
}

function assertCompleteFormatFacts(
  accepted: ReturnType<typeof acceptedProjection>,
  expected: readonly FormatFactOracle[],
): void {
  const comparable = (fact: FormatFactOracle) =>
    `${fact.property}\u0000${fact.value}\u0000${fact.locator}`;
  assert.deepEqual(
    accepted.metadata
      .filter((fact) => fact.sourceRecordIds.length === 0)
      .map((fact) => ({
        property: fact.property,
        value: fact.value,
        locator: fact.observedArtifactPart?.locator ?? "",
      }))
      .map(comparable)
      .toSorted(),
    expected.map(comparable).toSorted(),
    "revision-bound EPUB facts must be complete and must not include path-derived metadata",
  );
}

function expectedNbinetRequest(isbn: string): string {
  const query = new URLSearchParams({
    inst: "886NCL_NBINET",
    vid: "886NCL_NBINET:NBINET",
    lang: "zh-tw",
    q: `isbn,exact,${isbn}`,
    scope: "MyInstitution",
    tab: "NBINET",
    skipDelivery: "Y",
  });
  return `https://nbinet.primo.exlibrisgroup.com/primaws/rest/pub/pnxs?${query}`;
}

async function exactOfficialProjection(
  official: OfficialOracle,
): Promise<readonly [string, CanonicalOfficialProjection]> {
  assert.equal(official.requestAddress, expectedNbinetRequest(official.isbn));
  assert.equal(official.sourceAddress, canonicalSourceAddress(official.isbn));
  const response = await fetch(official.requestAddress, {
    method: "GET",
    redirect: "error",
  });
  assert.equal(
    response.ok,
    true,
    `NBINet exact request failed with HTTP ${String(response.status)}`,
  );
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const value = Number(declaredLength);
    assert.equal(
      Number.isSafeInteger(value) &&
        value > 0 &&
        value <= maximumOfficialResponseBytes,
      true,
      "NBINet exact response declared an invalid body size",
    );
  }
  assert.ok(response.body, "NBINet exact response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumOfficialResponseBytes) {
        await reader.cancel();
        throw new Error("NBINet exact response exceeded the body limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return [
    official.isbn,
    canonicalExactOfficialResponse(
      bytes,
      official.isbn,
      official.sourceAddress,
    ),
  ];
}

type ExactOfficialAcceptedProjection = {
  readonly sourceAssociations: readonly {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  }[];
  readonly recognitionSourceAssociation?: {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  };
  readonly metadata: readonly {
    readonly property: string;
    readonly value: string;
    readonly sourceRecordIds: readonly string[];
  }[];
};

/** 只使用普通 CLI 公开 DTO 证明本次 transient official response 的完整投影。 */
export function assertExactOfficialPublicProjection(
  sourceRecords: AssetRefreshInspection["sourceRecords"],
  accepted: ExactOfficialAcceptedProjection,
  official: OfficialOracle,
  direct: CanonicalOfficialProjection,
): void {
  assert.equal(sourceRecords.length, 1);
  const sourceRecord = sourceRecords[0]!;
  assert.deepEqual(
    {
      sourceIdentity: sourceRecord.sourceIdentity,
      nativeAddress: sourceRecord.nativeAddress,
      coverage: sourceRecord.coverage,
    },
    {
      sourceIdentity: "nbinet",
      nativeAddress: official.sourceAddress,
      coverage: {
        id: "nbinet.exact-isbn",
        completeness: "complete",
        authority: "official",
      },
    },
    "public NBINet Source Record provenance drifted",
  );
  assert.match(
    sourceRecord.digest,
    /^[0-9a-f]{64}$/u,
    "public NBINet Source Record digest must be lowercase SHA-256",
  );
  assert.deepEqual(accepted.sourceAssociations, [
    { sourceIdentity: "nbinet", nativeAddress: official.sourceAddress },
  ]);
  assert.deepEqual(accepted.recognitionSourceAssociation, {
    sourceIdentity: "nbinet",
    nativeAddress: official.sourceAddress,
  });
  assert.equal(direct.isbn, official.isbn);
  assert.equal(direct.sourceAddress, official.sourceAddress);
  const propertyValues = (items: readonly OfficialMetadata[]) =>
    items.map(comparableMetadata).toSorted();
  assert.deepEqual(
    propertyValues(direct.metadata),
    propertyValues(official.metadata),
    "direct official metadata must equal the reviewed property/value multiset",
  );
  const sourcedMetadata = accepted.metadata
    .filter((item) => item.sourceRecordIds.length > 0)
    .map(({ property, value, sourceRecordIds }) => ({
      property,
      value,
      sourceRecordIds,
    }));
  const sourcedComparable = (item: (typeof sourcedMetadata)[number]) =>
    JSON.stringify(item);
  const expectedSourced = (items: readonly OfficialMetadata[]) =>
    items
      .map(({ property, value }) => ({
        property,
        value,
        sourceRecordIds: [sourceRecord.id],
      }))
      .map(sourcedComparable)
      .toSorted();
  const actualSourced = sourcedMetadata.map(sourcedComparable).toSorted();
  assert.deepEqual(
    actualSourced,
    expectedSourced(direct.metadata),
    "CLI sourced metadata must equal the direct official property/value multiset",
  );
  assert.deepEqual(
    actualSourced,
    expectedSourced(official.metadata),
    "CLI sourced metadata must equal the reviewed property/value multiset",
  );
}

function assertOfficialProjection(
  value: AssetRefreshInspection,
  accepted: ReturnType<typeof acceptedProjection>,
  official: OfficialOracle | undefined,
  direct: CanonicalOfficialProjection | undefined,
): void {
  if (official === undefined) {
    assert.equal(direct, undefined);
    assert.deepEqual(value.sourceRecords, []);
    assert.deepEqual(accepted.sourceAssociations, []);
    assert.equal(accepted.recognitionSourceAssociation, undefined);
    assert.match(accepted.recognitionExplanation, /无有效 ISBN/u);
    return;
  }
  assert.equal(official.requestAddress, expectedNbinetRequest(official.isbn));
  assert.ok(direct, "transient NBINet canonical projection is missing");
  assertExactOfficialPublicProjection(
    value.sourceRecords,
    accepted,
    official,
    direct,
  );
}

function stableBusinessProjection(
  value: AssetRefreshInspection,
  accepted: ReturnType<typeof acceptedProjection>,
): unknown {
  return {
    sourceRecords: value.sourceRecords.map((record) => ({
      sourceIdentity: record.sourceIdentity,
      nativeAddress: record.nativeAddress,
      coverage: record.coverage,
    })),
    sourceAssociations: accepted.sourceAssociations,
    recognitionSourceAssociation: accepted.recognitionSourceAssociation,
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
        sourced: fact.sourceRecordIds.length > 0,
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
    relationshipCount: accepted.relationships?.length ?? 0,
  };
}

const sourceBusinessProjection = new Map<string, unknown>();

const journey: CliJourney = {
  name: "epub-publication-live",
  source: { mode: "real" },
  modes: ["source", "distribution"],
  async setup(context) {
    const untrustedOracle = JSON.parse(
      await readFile(
        path.join(corpusRoot(context), "references/reviewed-oracle.json"),
        "utf8",
      ),
    ) as unknown;
    assertApprovedEpubOracleSlice(untrustedOracle);
    const rawOracle = untrustedOracle as {
      readonly reviews: {
        readonly epub: {
          readonly status: string;
          readonly reviewedAt: string;
        };
      };
      readonly epubPublications: readonly PublicationOracle[];
    };
    assert.equal(
      rawOracle.reviews.epub.status,
      "reviewed-current-official-source",
    );
    assert.equal(rawOracle.reviews.epub.reviewedAt, "2026-08-30");
    const allRoots = await fixedCorpusRoots(context);
    const owner = fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle(
      rawOracle,
      allRoots,
    ).find((group) => group.ownerTicket === ownerTicket);
    assert.ok(owner, "EPUB fixed-corpus ownership group is missing");
    assert.equal(owner.status, "implemented");
    assert.equal(owner.journey, journey.name);
    assert.equal(rawOracle.epubPublications.length, 6);
    assert.equal(
      rawOracle.epubPublications.filter((item) => item.official !== undefined)
        .length,
      2,
    );
    const officialProjections = new Map<string, CanonicalOfficialProjection>();
    for (const item of rawOracle.epubPublications)
      if (item.official !== undefined) {
        const [isbn, projection] = await exactOfficialProjection(item.official);
        officialProjections.set(isbn, projection);
      }
    assert.equal(officialProjections.size, 2);
    assert.equal(
      new Set([...officialProjections.values()].map(({ digest }) => digest))
        .size,
      2,
      "the two exact ISBN canonical projections must remain distinct",
    );
    exactRootSet(
      rawOracle.epubPublications.map((item) => item.logicalRoot),
      owner.roots.map((root) => root.logicalRoot),
    );
    const byRoot = new Map(owner.roots.map((root) => [root.logicalRoot, root]));
    const roots = rawOracle.epubPublications.map(
      (publication) => byRoot.get(publication.logicalRoot)!,
    );
    const deepIntegrity = process.env.DIGITAL_DEEP_CORPUS_INTEGRITY === "1";
    const before = await captureFixedCorpusSnapshots(roots, deepIntegrity);
    const deepBefore = deepIntegrity
      ? fixedCorpusContentDigestsFromSnapshots(roots, before)
      : undefined;
    if (deepBefore !== undefined)
      await assertFixedCorpusContentBaselineSubset(context, deepBefore);
    stateByContext.set(stateKey(context), {
      roots,
      publications: rawOracle.epubPublications,
      before,
      officialProjections,
      ...(deepBefore === undefined ? {} : { deepBefore }),
    });
  },
  commands(context) {
    const state = currentState(context);
    const environment = {
      DIGITAL_PRODUCT_DATA: context.productDataDirectory,
    };
    return [
      ...state.roots.map((root, index) => ({
        name: `register EPUB publication root ${String(index + 1)}`,
        args: [
          "library-create",
          `EPUB publication ${String(index + 1)}`,
          "--directory",
          root.directory,
          "--json",
        ],
        env: environment,
        haltOnFailure: true,
      })),
      ...state.roots.map((_root, index) => ({
        name: `live refresh EPUB publication ${String(index + 1)}`,
        args: (results: readonly CliJourneyResult[]) => [
          "scan",
          registeredObservedRootId(results[index]),
          "--scope",
          ".",
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
        env: environment,
        haltOnFailure: true,
      })),
    ];
  },
  async assertions({ context, results: allResults }) {
    const state = currentState(context);
    try {
      for (const result of allResults.slice(0, state.roots.length)) {
        assert.equal(result.exitCode, 0, result.stderr);
        registeredObservedRootId(result);
      }
      const results = allResults.slice(state.roots.length);
      assert.equal(results.length, state.publications.length);
      const assetIds = new Set<string>();
      for (const [index, publication] of state.publications.entries()) {
        const result = results[index]!;
        assert.equal(result.exitCode, 0, result.stderr);
        const value = inspection(result);
        assert.equal(value.execution.outcome, "accepted");
        const accepted = acceptedProjection(value);
        assert.equal(accepted.entity.kind, "digital-asset");
        assert.equal(assetIds.has(accepted.entity.id), false);
        assetIds.add(accepted.entity.id);
        const revisionBlob = accepted.blobs.find(
          (blob) => blob.digest === publication.revision.digest,
        );
        assert.deepEqual(revisionBlob, publication.revision);
        assert.equal(
          accepted.artifactRevisions.some(
            (revision) => revision.blobDigest === publication.revision.digest,
          ),
          true,
        );
        for (const fact of publication.formatFacts)
          assertFormatFact(accepted, fact);
        assertCompleteFormatFacts(accepted, publication.formatFacts);
        const covers = accepted.artifactAssociations.filter(
          (association) => association.role === "asset.primary-cover",
        );
        assert.equal(covers.length, 1);
        assert.equal(
          covers[0]!.observedArtifactPart?.locator,
          publication.cover.locator,
        );
        assert.match(publication.cover.locator, /^epub:/u);
        const coverArtifact = accepted.artifacts.find(
          (artifact) => artifact.id === covers[0]!.artifactId,
        );
        assert.ok(coverArtifact);
        const coverRevision = accepted.artifactRevisions.find(
          (revision) => revision.artifactId === coverArtifact.id,
        );
        assert.ok(coverRevision);
        const parentRevision = accepted.artifactRevisions.find(
          (revision) => revision.blobDigest === publication.revision.digest,
        );
        assert.ok(parentRevision);
        assert.equal(
          covers[0]!.observedArtifactPart?.revisionId,
          parentRevision.id,
          "cover locator must remain bound to the exact parent EPUB revision",
        );
        assert.equal(
          accepted.blobs.find(
            (blob) => blob.digest === coverRevision.blobDigest,
          )?.mediaType,
          publication.cover.mediaType,
        );
        assertOfficialProjection(
          value,
          accepted,
          publication.official,
          publication.official === undefined
            ? undefined
            : state.officialProjections.get(publication.official.isbn),
        );
        assert.deepEqual(accepted.currentRelatedEntities ?? [], []);
        assert.deepEqual(accepted.entityMentions ?? [], []);
        assert.deepEqual(accepted.relationships ?? [], []);
        const stable = stableBusinessProjection(value, accepted);
        if (context.mode === "source")
          sourceBusinessProjection.set(publication.logicalRoot, stable);
        else if (sourceBusinessProjection.has(publication.logicalRoot))
          assert.deepEqual(
            stable,
            sourceBusinessProjection.get(publication.logicalRoot),
            `source/distribution projection drifted: ${publication.logicalRoot}`,
          );
      }
      assert.equal(assetIds.size, 6);
      const after = await captureFixedCorpusSnapshots(
        state.roots,
        state.deepBefore !== undefined,
      );
      assert.deepEqual(
        after,
        state.before,
        "EPUB fixed roots changed during the live journey",
      );
      if (state.deepBefore !== undefined) {
        const deepAfter = fixedCorpusContentDigestsFromSnapshots(
          state.roots,
          after,
        );
        await assertFixedCorpusContentBaselineSubset(context, deepAfter);
        assert.deepEqual(deepAfter, state.deepBefore);
      }
      for (const [isbn, projection] of [...state.officialProjections].toSorted(
        ([left], [right]) => left.localeCompare(right),
      ))
        console.log(
          `epub-publication-live NBINet ${isbn} canonical-sha256 ${projection.digest}`,
        );
    } finally {
      stateByContext.delete(stateKey(context));
    }
  },
};

export default journey;
