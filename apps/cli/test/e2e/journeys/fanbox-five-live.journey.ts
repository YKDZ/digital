import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  assertFixedCorpusContentBaselineSubset,
  captureFixedCorpusSnapshots,
  fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle,
  fixedCorpusContentDigestsFromSnapshots,
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

type FanboxBodyBlockOracle = {
  readonly ordinal: number;
  readonly type: "header" | "p" | "image" | "file" | "embed" | "url_embed";
  readonly value: Readonly<Record<string, unknown>>;
};

type FanboxAttachmentOracle = {
  readonly ordinal: number;
  readonly name?: string;
  readonly kind: "file" | "image";
  readonly byteLength?: string;
};

export type FanboxPostOracle = {
  readonly logicalRoot: string;
  readonly directoryDate: string;
  readonly sourceNativeAddress: string;
  readonly title: string;
  readonly publishedDatetime: string;
  readonly postType: "text" | "file" | "image" | "video" | "article";
  readonly creatorId: string;
  readonly entitlement: "available" | "restricted";
  readonly cover: "present" | "absent";
  readonly body:
    | {
        readonly status: "available";
        readonly text: string;
        readonly blocks: readonly FanboxBodyBlockOracle[];
      }
    | {
        readonly status: "restricted";
        readonly blocks: readonly [];
      };
  readonly attachments: readonly FanboxAttachmentOracle[];
};

type MetadataFact = {
  readonly id?: string;
  readonly property: string;
  readonly sourceSlot?: string;
  readonly value: string;
  readonly sourceRecordIds: readonly string[];
  readonly qualifiers?: readonly {
    readonly key: string;
    readonly value: string;
  }[];
};

type AcceptedProjection = {
  readonly entity: { readonly id: string };
  readonly sourceAssociations: readonly {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  }[];
  readonly recognitionSourceAssociation?: {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  };
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
  readonly metadata: readonly MetadataFact[];
  readonly sourceArtifactCandidates?: readonly {
    readonly sourceRecordId: string;
    readonly role: string;
    readonly mediaType: string;
    readonly selectionEvidence?: {
      readonly suggestedFilename?: string;
      readonly declaredByteLength?: number;
      readonly sourceOrdinal?: number;
    };
  }[];
  readonly entities?: readonly {
    readonly id?: string;
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

export type FanboxJourneyInspection = {
  readonly execution: {
    readonly outcome: string;
    readonly reusedExecutionId?: string;
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
  readonly accepted?: AcceptedProjection;
};

type JourneyState = {
  readonly posts: readonly FanboxPostOracle[];
  readonly roots: readonly FixedCorpusRoot[];
  readonly signatures: ReadonlyMap<string, readonly string[]>;
  readonly deepBefore?: ReadonlyMap<string, FixedCorpusContentDigest>;
};

const stateByContext = new Map<string, JourneyState>();

function stateKey(context: CliJourneyContext): string {
  return `${context.mode}\u0000${context.workDir}`;
}

function currentState(context: CliJourneyContext): JourneyState {
  const state = stateByContext.get(stateKey(context));
  if (state === undefined)
    throw new Error("FANBOX live journey was not set up");
  return state;
}

function corpusRoot(context: CliJourneyContext): string {
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
  const id = inspection(result).accepted?.entity.id;
  if (id === undefined)
    throw new Error(`expected accepted asset id in ${result?.stdout ?? ""}`);
  return id;
}

function inspection(
  result: CliJourneyResult | undefined,
): FanboxJourneyInspection {
  return JSON.parse(result?.stdout ?? "{}") as FanboxJourneyInspection;
}

function qualifier(fact: MetadataFact, key: string): string | undefined {
  return fact.qualifiers?.find((item) => item.key === key)?.value;
}

function exactMetadataValue(
  accepted: AcceptedProjection,
  property: string,
): string | undefined {
  const values = accepted.metadata.filter((item) => item.property === property);
  assert.ok(
    values.length <= 1,
    `${property} must have at most one current value`,
  );
  return values[0]?.value;
}

function assertBodyProjection(
  accepted: AcceptedProjection,
  post: FanboxPostOracle,
): void {
  if (post.body.status === "available")
    assert.equal(exactMetadataValue(accepted, "asset.body"), post.body.text);
  else assert.equal(exactMetadataValue(accepted, "asset.body"), undefined);
  const actual = accepted.metadata
    .filter((item) => item.property === "fanbox.post.body-block")
    .map((item) => ({
      ordinal: Number(qualifier(item, "fanbox.post.block-ordinal")),
      type: qualifier(item, "fanbox.post.block-type"),
      value: JSON.parse(item.value) as unknown,
      sourceRecordIds: item.sourceRecordIds,
    }))
    .toSorted((left, right) => left.ordinal - right.ordinal);
  assert.deepEqual(
    actual.map(({ sourceRecordIds: _sourceRecordIds, ...item }) => item),
    post.body.blocks,
    "FANBOX complete body block projection drifted",
  );
  assert.equal(
    actual.every((item) => item.sourceRecordIds.length > 0),
    true,
    "FANBOX body blocks require current Source Record provenance",
  );
}

function assertAttachmentProjection(
  accepted: AcceptedProjection,
  post: FanboxPostOracle,
): void {
  const actual = (accepted.sourceArtifactCandidates ?? [])
    .filter((candidate) => candidate.role.startsWith("fanbox.attachment."))
    .toSorted(
      (left, right) =>
        (left.selectionEvidence?.sourceOrdinal ?? Number.MAX_SAFE_INTEGER) -
        (right.selectionEvidence?.sourceOrdinal ?? Number.MAX_SAFE_INTEGER),
    )
    .map((candidate) => ({
      ordinal: candidate.selectionEvidence?.sourceOrdinal,
      kind: candidate.role.slice("fanbox.attachment.".length),
      ...(candidate.selectionEvidence?.suggestedFilename === undefined
        ? {}
        : { name: candidate.selectionEvidence.suggestedFilename }),
      ...(candidate.selectionEvidence?.declaredByteLength === undefined
        ? {}
        : {
            byteLength: String(candidate.selectionEvidence.declaredByteLength),
          }),
    }));
  assert.deepEqual(
    actual,
    post.attachments,
    "FANBOX attachment listing drifted",
  );
}

function stableAcceptedProjection(accepted: AcceptedProjection): unknown {
  return {
    entityId: accepted.entity.id,
    sourceAssociations: accepted.sourceAssociations,
    recognitionSourceAssociation: accepted.recognitionSourceAssociation,
    artifacts: accepted.artifacts.map((item) => item.id).toSorted(),
    locations: accepted.locations
      .map((item) => ({ artifactId: item.artifactId, kind: item.kind }))
      .toSorted((left, right) =>
        left.artifactId.localeCompare(right.artifactId),
      ),
    artifactAssociations: accepted.artifactAssociations
      .map((item) => ({ artifactId: item.artifactId, role: item.role }))
      .toSorted((left, right) =>
        `${left.artifactId}:${left.role}`.localeCompare(
          `${right.artifactId}:${right.role}`,
        ),
      ),
    metadata: accepted.metadata
      .map((item) => ({
        property: item.property,
        sourceSlot: item.sourceSlot,
        value: item.value,
        qualifiers: item.qualifiers,
      }))
      .toSorted((left, right) =>
        `${left.property}:${left.sourceSlot ?? ""}`.localeCompare(
          `${right.property}:${right.sourceSlot ?? ""}`,
        ),
      ),
    sourceArtifactCandidates: accepted.sourceArtifactCandidates?.map(
      ({ role, mediaType, selectionEvidence }) => ({
        role,
        mediaType,
        selectionEvidence,
      }),
    ),
    entities: (accepted.entities ?? [])
      .map((item) => ({ id: item.id, sourceKey: item.sourceKey }))
      .toSorted((left, right) => (left.id ?? "").localeCompare(right.id ?? "")),
  };
}

export function assertFanboxAcceptedPost(
  value: FanboxJourneyInspection,
  post: FanboxPostOracle,
): void {
  assert.equal(value.execution.outcome, "accepted");
  assert.deepEqual(
    value.sourceRecords.map((record) => record.coverage.id),
    ["fanbox.creator-post-summaries", "fanbox.post-detail"],
  );
  assert.equal(
    value.sourceRecords.every((record) => record.sourceIdentity === "fanbox"),
    true,
  );
  const accepted = value.accepted;
  assert.ok(accepted, "FANBOX accepted projection is missing");
  const expectedSourceAssociation = {
    sourceIdentity: "fanbox",
    nativeAddress: `https://www.fanbox.cc/@${post.creatorId}/posts/${post.sourceNativeAddress}`,
  };
  assert.deepEqual(accepted.sourceAssociations, [expectedSourceAssociation]);
  assert.ok(
    accepted.recognitionSourceAssociation,
    "FANBOX accepted projection is missing its recognition source",
  );
  assert.deepEqual(
    accepted.recognitionSourceAssociation,
    expectedSourceAssociation,
  );
  for (const [property, expected] of [
    ["asset.title", post.title],
    ["asset.publication-datetime", post.publishedDatetime],
    ["fanbox.post.form", post.postType],
    ["fanbox.post.entitlement", post.entitlement],
  ] as const)
    assert.equal(exactMetadataValue(accepted, property), expected);
  assertBodyProjection(accepted, post);
  assertAttachmentProjection(accepted, post);
  assert.equal(
    accepted.entities?.some((entity) => entity.sourceKey === post.creatorId),
    true,
  );
  const sourcedFacts = [
    ...accepted.metadata,
    ...(accepted.entityMentions ?? []),
    ...(accepted.entityResolutionDecisions ?? []),
    ...(accepted.relationships ?? []),
  ];
  const currentSourceRecordIds = new Set(
    value.sourceRecords.map((record) => record.id),
  );
  assert.equal(
    sourcedFacts.every(
      (fact) =>
        fact.sourceRecordIds.length > 0 &&
        fact.sourceRecordIds.every((id) => currentSourceRecordIds.has(id)),
    ),
    true,
    "FANBOX facts must cite only this execution's current Source Records",
  );
  assert.equal(
    accepted.entities?.every(
      (entity) =>
        entity.sourceRecordIds.length > 0 &&
        entity.sourceRecordIds.every((id) => currentSourceRecordIds.has(id)),
    ),
    true,
  );
  const observedArtifactIds = new Set(
    accepted.locations
      .filter((location) => location.kind === "observed")
      .map((location) => location.artifactId),
  );
  assert.equal(
    accepted.artifactAssociations
      .filter((association) => observedArtifactIds.has(association.artifactId))
      .every((association) => association.role === "asset.material-delivered"),
    true,
  );
  const managedArtifactIds = new Set(
    accepted.locations
      .filter((location) => location.kind === "managed")
      .map((location) => location.artifactId),
  );
  const sourceArtifacts = accepted.artifactAssociations.filter(
    (association) => (association.sourceRecordIds?.length ?? 0) > 0,
  );
  assert.equal(
    sourceArtifacts.every(
      (association) =>
        association.role === "asset.primary-cover" &&
        managedArtifactIds.has(association.artifactId),
    ),
    true,
    "FANBOX journey managed an unrequested source attachment",
  );
  assert.equal(
    sourceArtifacts.filter(
      (association) => association.role === "asset.primary-cover",
    ).length,
    post.cover === "present" ? 1 : 0,
  );
}

export function assertFanboxRefreshedPost(
  initial: FanboxJourneyInspection,
  refreshed: FanboxJourneyInspection,
  post: FanboxPostOracle,
): void {
  assertFanboxAcceptedPost(refreshed, post);
  assert.ok(initial.accepted, "initial FANBOX projection is missing");
  assert.ok(refreshed.accepted, "refreshed FANBOX projection is missing");
  assert.deepEqual(
    stableAcceptedProjection(refreshed.accepted),
    stableAcceptedProjection(initial.accepted),
    "FANBOX refresh changed stable identity or reviewed business facts",
  );
}

export function assertFanboxReopenedPost(
  initial: FanboxJourneyInspection,
  reopened: FanboxJourneyInspection,
  post: FanboxPostOracle,
): void {
  assert.equal(reopened.execution.outcome, "no-change");
  assert.deepEqual(reopened.sourceRecords, []);
  const prior = initial.accepted;
  const current = reopened.accepted;
  assert.ok(prior, "initial FANBOX projection is missing");
  assert.ok(current, "reopened FANBOX projection is missing");
  assert.deepEqual(
    stableAcceptedProjection(current),
    stableAcceptedProjection(prior),
    "FANBOX identity and business facts changed after SQLite reopen",
  );
  assertBodyProjection(current, post);
  assertAttachmentProjection(current, post);
}

function oracleRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function oracleArray(value: unknown, label: string): readonly unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function oracleString(value: unknown, label: string): string {
  assert.equal(
    typeof value === "string" && value.trim().length > 0,
    true,
    `${label} must be a non-empty string`,
  );
  return value as string;
}

function oracleParagraphText(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be a string`);
  const text = value as string;
  assert.equal(
    text === "" || text.trim().length > 0,
    true,
    `${label} must be exactly empty or contain non-whitespace text`,
  );
  return text;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  assert.deepEqual(
    Object.keys(value).toSorted(),
    [...keys].toSorted(),
    `${label} shape drifted`,
  );
}

function assertOracleBodyBlock(value: unknown, ordinal: number): void {
  const block = oracleRecord(value, `FANBOX reviewed body block ${ordinal}`);
  assertExactKeys(
    block,
    ["ordinal", "type", "value"],
    `FANBOX reviewed body block ${ordinal}`,
  );
  assert.equal(
    block.ordinal,
    ordinal,
    "FANBOX reviewed body ordinals must be contiguous",
  );
  const type = oracleString(
    block.type,
    `FANBOX reviewed body block ${ordinal} type`,
  );
  assert.ok(
    ["header", "p", "image", "file", "embed", "url_embed"].includes(type),
    `FANBOX reviewed body block ${ordinal} type was invalid`,
  );
  const projected = oracleRecord(
    block.value,
    `FANBOX reviewed body block ${ordinal} value`,
  );
  assert.equal(
    projected.type,
    type,
    `FANBOX reviewed body block ${ordinal} value type drifted`,
  );
  if (type === "header" || type === "p") {
    assertExactKeys(
      projected,
      ["type", "text"],
      `FANBOX reviewed body block ${ordinal} value`,
    );
    const label = `FANBOX reviewed body block ${ordinal} text`;
    if (type === "p") oracleParagraphText(projected.text, label);
    else oracleString(projected.text, label);
  } else if (type === "file" || type === "image") {
    const reference = type === "file" ? "fileId" : "imageId";
    assertExactKeys(
      projected,
      ["type", reference],
      `FANBOX reviewed body block ${ordinal} value`,
    );
    oracleString(
      projected[reference],
      `FANBOX reviewed body block ${ordinal} reference`,
    );
  } else if (type === "embed") {
    assertExactKeys(
      projected,
      ["type", "embed"],
      `FANBOX reviewed body block ${ordinal} value`,
    );
    const embed = oracleRecord(
      projected.embed,
      `FANBOX reviewed body block ${ordinal} embed`,
    );
    assertExactKeys(
      embed,
      ["id", "serviceProvider", "contentId"],
      `FANBOX reviewed body block ${ordinal} embed`,
    );
    oracleString(
      embed.id,
      `FANBOX reviewed body block ${ordinal} embed identity`,
    );
    oracleString(
      embed.serviceProvider,
      `FANBOX reviewed body block ${ordinal} embed provider`,
    );
    oracleString(
      embed.contentId,
      `FANBOX reviewed body block ${ordinal} embed content identity`,
    );
  } else {
    assertExactKeys(
      projected,
      ["type", "urlEmbed"],
      `FANBOX reviewed body block ${ordinal} value`,
    );
    const embed = oracleRecord(
      projected.urlEmbed,
      `FANBOX reviewed body block ${ordinal} URL embed`,
    );
    const embedType = oracleString(
      embed.type,
      `FANBOX reviewed body block ${ordinal} URL embed type`,
    );
    if (embedType === "default") {
      assertExactKeys(
        embed,
        ["id", "type", "url"],
        `FANBOX reviewed body block ${ordinal} URL embed`,
      );
      oracleString(
        embed.url,
        `FANBOX reviewed body block ${ordinal} URL embed address`,
      );
    } else if (embedType === "html" || embedType === "html.card") {
      assertExactKeys(
        embed,
        ["id", "type", "html"],
        `FANBOX reviewed body block ${ordinal} URL embed`,
      );
      oracleString(
        embed.html,
        `FANBOX reviewed body block ${ordinal} URL embed HTML`,
      );
    } else {
      assert.equal(
        embedType,
        "fanbox.post",
        `FANBOX reviewed body block ${ordinal} URL embed type was invalid`,
      );
      assertExactKeys(
        embed,
        ["id", "type", "postInfo"],
        `FANBOX reviewed body block ${ordinal} URL embed`,
      );
      const postInfo = oracleRecord(
        embed.postInfo,
        `FANBOX reviewed body block ${ordinal} URL embed post`,
      );
      assertExactKeys(
        postInfo,
        ["id"],
        `FANBOX reviewed body block ${ordinal} URL embed post`,
      );
      oracleString(
        postInfo.id,
        `FANBOX reviewed body block ${ordinal} URL embed post identity`,
      );
    }
    oracleString(
      embed.id,
      `FANBOX reviewed body block ${ordinal} URL embed identity`,
    );
  }
}

function assertReviewedOracle(value: unknown): readonly FanboxPostOracle[] {
  const posts = oracleArray(value, "reviewed creator-post selection");
  assert.equal(posts.length, 5, "reviewed creator-post selection drifted");
  const identities = new Set<string>();
  const logicalRoots = new Set<string>();
  for (const [postIndex, rawPost] of posts.entries()) {
    const post = oracleRecord(rawPost, `FANBOX reviewed post ${postIndex}`);
    assertExactKeys(
      post,
      [
        "logicalRoot",
        "directoryDate",
        "sourceNativeAddress",
        "title",
        "publishedDatetime",
        "postType",
        "creatorId",
        "entitlement",
        "cover",
        "body",
        "attachments",
      ],
      `FANBOX reviewed post ${postIndex}`,
    );
    const logicalRoot = oracleString(
      post.logicalRoot,
      `FANBOX reviewed post ${postIndex} logical root`,
    );
    assert.equal(
      logicalRoots.has(logicalRoot),
      false,
      "FANBOX reviewed logical roots must be unique",
    );
    logicalRoots.add(logicalRoot);
    const directoryDate = oracleString(
      post.directoryDate,
      `FANBOX reviewed post ${postIndex} directory date`,
    );
    assert.match(directoryDate, /^\d{4}-\d{2}-\d{2}$/u);
    assert.equal(
      new Date(`${directoryDate}T00:00:00Z`).toISOString().slice(0, 10),
      directoryDate,
    );
    const sourceNativeAddress = oracleString(
      post.sourceNativeAddress,
      `FANBOX reviewed post ${postIndex} native address`,
    );
    assert.match(sourceNativeAddress, /^(?:0|[1-9]\d*)$/u);
    assert.equal(
      Number.isSafeInteger(Number(sourceNativeAddress)) &&
        Number(sourceNativeAddress) > 0,
      true,
      `FANBOX reviewed post ${postIndex} native address must be a positive safe integer`,
    );
    const creatorId = oracleString(
      post.creatorId,
      `FANBOX reviewed post ${postIndex} creator`,
    );
    assert.match(creatorId, /^[0-9A-Za-z_-]+$/u);
    const identity = `${creatorId}\u0000${sourceNativeAddress}`;
    assert.equal(
      identities.has(identity),
      false,
      "FANBOX reviewed post identities must be unique",
    );
    identities.add(identity);
    oracleString(post.title, `FANBOX reviewed post ${postIndex} title`);
    const publishedDatetime = oracleString(
      post.publishedDatetime,
      `FANBOX reviewed post ${postIndex} publication datetime`,
    );
    assert.match(
      publishedDatetime,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
    );
    assert.equal(Number.isNaN(Date.parse(publishedDatetime)), false);
    assert.equal(publishedDatetime.slice(0, 10), directoryDate);
    assert.ok(
      ["text", "file", "image", "video", "article"].includes(
        post.postType as string,
      ),
    );
    assert.ok(["available", "restricted"].includes(post.entitlement as string));
    assert.ok(["present", "absent"].includes(post.cover as string));
    const body = oracleRecord(
      post.body,
      `FANBOX reviewed post ${postIndex} body`,
    );
    const status = oracleString(
      body.status,
      `FANBOX reviewed post ${postIndex} body status`,
    );
    if (status === "available") {
      assertExactKeys(
        body,
        ["status", "text", "blocks"],
        `FANBOX reviewed post ${postIndex} body`,
      );
      oracleString(body.text, `FANBOX reviewed post ${postIndex} body text`);
    } else {
      assert.equal(
        status,
        "restricted",
        `FANBOX reviewed post ${postIndex} body status was invalid`,
      );
      assertExactKeys(
        body,
        ["status", "blocks"],
        `FANBOX reviewed post ${postIndex} body`,
      );
    }
    const blocks = oracleArray(
      body.blocks,
      `FANBOX reviewed post ${postIndex} body blocks`,
    );
    if (status === "restricted") assert.equal(blocks.length, 0);
    for (const [ordinal, block] of blocks.entries())
      assertOracleBodyBlock(block, ordinal);
    const attachments = oracleArray(
      post.attachments,
      `FANBOX reviewed post ${postIndex} attachments`,
    );
    for (const [ordinal, rawAttachment] of attachments.entries()) {
      const attachment = oracleRecord(
        rawAttachment,
        `FANBOX reviewed post ${postIndex} attachment ${ordinal}`,
      );
      assertExactKeys(
        attachment,
        [
          "ordinal",
          "kind",
          ...(Object.hasOwn(attachment, "name") ? ["name"] : []),
          ...(Object.hasOwn(attachment, "byteLength") ? ["byteLength"] : []),
        ],
        `FANBOX reviewed post ${postIndex} attachment ${ordinal}`,
      );
      assert.equal(
        attachment.ordinal,
        ordinal,
        "FANBOX reviewed attachment ordinals must be contiguous",
      );
      if (Object.hasOwn(attachment, "name"))
        oracleString(
          attachment.name,
          `FANBOX reviewed post ${postIndex} attachment ${ordinal} name`,
        );
      assert.ok(attachment.kind === "file" || attachment.kind === "image");
      if (Object.hasOwn(attachment, "byteLength")) {
        const byteLength = oracleString(
          attachment.byteLength,
          `FANBOX reviewed post ${postIndex} attachment ${ordinal} byte length`,
        );
        assert.match(byteLength, /^(?:0|[1-9]\d*)$/u);
        assert.equal(Number.isSafeInteger(Number(byteLength)), true);
      }
    }
    if (post.entitlement === "restricted") {
      assert.equal(status, "restricted");
      assert.equal(attachments.length, 0);
    } else assert.equal(status, "available");
  }
  return posts as readonly FanboxPostOracle[];
}

function assertExactLogicalRoots(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  assert.equal(
    new Set(actual).size,
    actual.length,
    `${label} contains duplicate roots`,
  );
  assert.deepEqual(
    [...actual].toSorted(),
    [...expected].toSorted(),
    `${label} root set drifted`,
  );
}

export function fanboxJourneyCommands(
  context: CliJourneyContext,
  posts: readonly FanboxPostOracle[],
  roots: readonly Pick<FixedCorpusRoot, "directory">[],
): readonly CliJourneyCommand[] {
  const data = path.join(context.workDir, "product-data");
  const productEnv = { DIGITAL_PRODUCT_DATA: data };
  const scan = (index: number, name: string): CliJourneyCommand => ({
    name,
    args: (results) => [
      "scan",
      registeredObservedRootId(results[index + 1]),
      "--scope",
      ".",
      "--json",
    ],
    env: productEnv,
    haltOnFailure: true,
  });
  return [
    {
      name: "import FANBOX creator connection",
      args: [
        "fanbox-connection-import",
        "customudon",
        path.resolve(context.packageRoot, "../..", "docs/fanbox.json"),
      ],
      env: productEnv,
      haltOnFailure: true,
    },
    ...roots.map((root, index) => ({
      name: `register FANBOX post root ${posts[index]!.sourceNativeAddress}`,
      args: [
        "root-create",
        `FANBOX ${posts[index]!.sourceNativeAddress}`,
        root.directory,
      ],
      env: productEnv,
      haltOnFailure: true,
    })),
    ...posts.map((_post, index) =>
      scan(
        index,
        `live accept FANBOX post ${posts[index]!.sourceNativeAddress}`,
      ),
    ),
    ...posts.map((_post, index) =>
      scan(
        index,
        `live no-change FANBOX post ${posts[index]!.sourceNativeAddress} after SQLite reopen`,
      ),
    ),
    ...posts.map((post, index) => ({
      name: `live metadata refresh FANBOX post ${post.sourceNativeAddress}`,
      args: (results: readonly CliJourneyResult[]) => [
        "refresh-metadata",
        acceptedAssetId(results[1 + posts.length + index]),
        "--json",
      ],
      env: productEnv,
      haltOnFailure: true,
    })),
  ];
}

const journey: CliJourney = {
  name: "fanbox-five-live",
  modes: ["source", "distribution"],
  async setup(context) {
    const corpus = corpusRoot(context);
    const rawOracle = JSON.parse(
      await readFile(
        path.join(corpus, "references/reviewed-oracle.json"),
        "utf8",
      ),
    ) as unknown;
    const oracle = oracleRecord(rawOracle, "FANBOX oracle");
    const reviews = oracleRecord(oracle.reviews, "FANBOX oracle reviews");
    const fanboxReview = oracleRecord(reviews.fanbox, "FANBOX oracle review");
    assert.equal(
      fanboxReview.status,
      "reviewed-current-official-source",
      "FANBOX oracle requires current official source review",
    );
    const posts = assertReviewedOracle(oracle.creatorPosts);
    const allRoots = await fixedCorpusRoots(context);
    const owner = fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle(
      rawOracle,
      allRoots,
    ).find(
      (group) =>
        group.ownerTicket ===
        "v1-live-acceptance/issues/02-fanbox-five-live-gate.md",
    );
    assert.ok(owner, "FANBOX fixed-corpus ownership group is missing");
    assertExactLogicalRoots(
      posts.map((post) => post.logicalRoot),
      owner.roots.map((root) => root.logicalRoot),
      "FANBOX reviewed oracle",
    );
    const roots = posts.map((post) => ({
      logicalRoot: post.logicalRoot,
      directory: path.join(corpus, "assets", ...post.logicalRoot.split("/")),
    }));
    const signatures = new Map<string, readonly string[]>();
    for (const root of roots) {
      assert.equal((await lstat(root.directory)).isDirectory(), true);
      signatures.set(root.logicalRoot, await entrySignature(root.directory));
    }
    const deepIntegrity = process.env.DIGITAL_DEEP_CORPUS_INTEGRITY === "1";
    const before = await captureFixedCorpusSnapshots(roots, deepIntegrity);
    assertExactLogicalRoots(
      [...before.keys()],
      roots.map((root) => root.logicalRoot),
      "FANBOX captured snapshot map",
    );
    const deepBefore = deepIntegrity
      ? fixedCorpusContentDigestsFromSnapshots(roots, before)
      : undefined;
    if (deepBefore !== undefined) {
      assertExactLogicalRoots(
        [...deepBefore.keys()],
        roots.map((root) => root.logicalRoot),
        "FANBOX deep content digest map",
      );
      await assertFixedCorpusContentBaselineSubset(context, deepBefore);
    }
    stateByContext.set(stateKey(context), {
      posts,
      roots,
      signatures,
      ...(deepBefore === undefined ? {} : { deepBefore }),
    });
  },
  commands(context) {
    const state = currentState(context);
    return fanboxJourneyCommands(context, state.posts, state.roots);
  },
  async assertions({ context, results: allResults }) {
    const state = currentState(context);
    try {
      const importedConnection = allResults[0];
      if (importedConnection === undefined)
        throw new Error("FANBOX live journey did not run connection import");
      assert.equal(importedConnection.exitCode, 0, importedConnection.stderr);
      for (const registeredRoot of allResults.slice(
        1,
        state.roots.length + 1,
      )) {
        assert.equal(registeredRoot.exitCode, 0, registeredRoot.stderr);
        registeredObservedRootId(registeredRoot);
      }
      const results = allResults.slice(state.roots.length + 1);
      assert.equal(results.length, state.posts.length * 3);
      for (const result of allResults) {
        assert.equal(result.exitCode, 0, result.stderr);
        assert.doesNotMatch(
          `${result.stdout}\n${result.stderr}`,
          /FANBOXSESSID|cf_clearance|docs[\\/]fanbox\.json|cookie/iu,
          "private FANBOX configuration leaked through journey output",
        );
      }
      const initial = results.slice(0, state.posts.length).map(inspection);
      const reopened = results
        .slice(state.posts.length, state.posts.length * 2)
        .map(inspection);
      const refreshed = results.slice(state.posts.length * 2).map(inspection);
      for (const [index, post] of state.posts.entries()) {
        assertFanboxAcceptedPost(initial[index]!, post);
        assertFanboxReopenedPost(initial[index]!, reopened[index]!, post);
        assertFanboxRefreshedPost(initial[index]!, refreshed[index]!, post);
        const observedCount = initial[index]!.accepted?.locations.filter(
          (location) => location.kind === "observed",
        ).length;
        assert.equal(
          observedCount,
          state.signatures
            .get(post.logicalRoot)
            ?.filter((entry) => entry.includes(":f:")).length,
        );
        assert.deepEqual(
          await entrySignature(state.roots[index]!.directory),
          state.signatures.get(post.logicalRoot),
        );
      }
      if (state.deepBefore !== undefined) {
        const after = await captureFixedCorpusSnapshots(state.roots, true);
        const deepAfter = fixedCorpusContentDigestsFromSnapshots(
          state.roots,
          after,
        );
        await assertFixedCorpusContentBaselineSubset(context, deepAfter);
        assert.deepEqual(
          deepAfter,
          state.deepBefore,
          "FANBOX live journey must not alter approved source bytes",
        );
      }
    } finally {
      stateByContext.delete(stateKey(context));
    }
  },
};

export default journey;
