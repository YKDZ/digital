import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CliJourneyContext, CliJourneyResult } from "../e2e/journey.ts";
import journey, {
  assertFanboxAcceptedPost,
  assertFanboxRefreshedPost,
  type FanboxJourneyInspection,
  type FanboxPostOracle,
} from "../e2e/journeys/fanbox-five-live.journey.ts";

const evidenceEnvironment = "DIGITAL_FANBOX_LIVE_FAILURE_EVIDENCE_PATH";
const cleanup: string[] = [];

afterEach(async () => {
  delete process.env[evidenceEnvironment];
  await Promise.all(
    cleanup
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true })),
  );
});

function reviewedPost(index: number): FanboxPostOracle {
  return {
    logicalRoot: `fanbox/post-${index}`,
    directoryDate: `2026-01-0${index}`,
    sourceNativeAddress: String(1000 + index),
    title: `reviewed post ${index}`,
    publishedDatetime: `2026-01-0${index}T00:00:00Z`,
    postType: "text",
    creatorId: "customudon",
    entitlement: "restricted",
    cover: "absent",
    body: { status: "restricted", blocks: [] },
    attachments: [],
  };
}

async function syntheticJourney(
  options: {
    readonly ownerTicket?: string;
  } = {},
): Promise<{
  readonly context: CliJourneyContext;
  readonly posts: readonly FanboxPostOracle[];
  readonly mediaFile: string;
  readonly evidencePath: string;
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "digital-fanbox-diagnostic-"),
  );
  cleanup.push(directory);
  const packageRoot = path.join(directory, "apps", "cli");
  const corpus = path.join(directory, ".scratch", "acceptance-corpus");
  const references = path.join(corpus, "references");
  const assets = path.join(corpus, "assets");
  const evidenceParent = path.join(directory, "evidence");
  const workDir = path.join(directory, "work");
  await Promise.all([
    mkdir(packageRoot, { recursive: true }),
    mkdir(references, { recursive: true }),
    mkdir(evidenceParent, { recursive: true }),
    mkdir(workDir, { recursive: true }),
  ]);
  await chmod(evidenceParent, 0o700);

  const posts = Array.from({ length: 5 }, (_, index) =>
    reviewedPost(index + 1),
  );
  const otherOwned = Array.from(
    { length: 19 },
    (_, index) => `owned/root-${index + 1}`,
  );
  const unowned = Array.from(
    { length: 5 },
    (_, index) => `unowned/root-${index + 1}`,
  );
  const logicalRoots = [
    ...posts.map((post) => post.logicalRoot),
    ...otherOwned,
    ...unowned,
  ];
  for (const post of posts) {
    const root = path.join(assets, ...post.logicalRoot.split("/"));
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "media.bin"), `media-${post.logicalRoot}`);
  }
  await writeFile(
    path.join(corpus, "files-from.txt"),
    `${logicalRoots.join("\n")}\n`,
  );
  let ownedOffset = 0;
  const ownership = [
    ["01-dlsite-eight-live-gate.md", "dlsite-eight-live", "implemented", 8],
    ["02-fanbox-five-live-gate.md", "fanbox-five-live", "external-gated", 0],
    [
      "03-epub-publication-live-gate.md",
      "epub-publication-live",
      "implemented",
      6,
    ],
    ["04-pdf-series-live-gate.md", "pdf-publication-live", "implemented", 1],
    [
      "05-bangumi-episodic-live-gate.md",
      "bangumi-episodic-live",
      "implemented",
      2,
    ],
    ["06-film-tmdb-omdb-live-gate.md", "tmdb-omdb-live", "implemented", 2],
  ].map(([ticket, ownerJourney, status, rawCount]) => {
    const count = rawCount as number;
    const roots =
      count === 0
        ? posts.map((post) => post.logicalRoot)
        : otherOwned.slice(ownedOffset, (ownedOffset += count));
    return {
      ownerTicket: `v1-live-acceptance/issues/${ticket}`,
      journey: ownerJourney,
      status,
      roots,
    };
  });
  if (options.ownerTicket !== undefined)
    ownership[1]!.ownerTicket = options.ownerTicket;
  await writeFile(
    path.join(references, "reviewed-oracle.json"),
    JSON.stringify({
      reviews: { fanbox: { status: "reviewed-current-official-source" } },
      creatorPosts: posts,
      dedicatedIntegrationOwnershipGroups: ownership,
    }),
  );

  const context = { mode: "source", packageRoot, workDir } as const;
  await journey.setup(context);
  return {
    context,
    posts,
    mediaFile: path.join(
      assets,
      ...posts[0]!.logicalRoot.split("/"),
      "media.bin",
    ),
    evidencePath: path.join(evidenceParent, "failure.json"),
  };
}

function commandResults(
  context: CliJourneyContext,
  posts: readonly FanboxPostOracle[],
  throughOrdinal: number,
): CliJourneyResult[] {
  return journey
    .commands(context)
    .slice(0, throughOrdinal)
    .map((command, index) => ({
      commandName: command.name,
      exitCode: 0,
      stdout:
        index >= 1 && index <= 5 ? JSON.stringify({ id: `root-${index}` }) : "",
      stderr: "",
    }));
}

function acceptedInspection(post: FanboxPostOracle, index: number): unknown {
  const sourceRecordIds = [`summary-${index}`, `detail-${index}`];
  const artifactId = `observed-${index}`;
  const managedCoverArtifactId = `managed-cover-${index}`;
  return {
    format: "temporary-asset-refresh-inspection/v1",
    execution: { outcome: "accepted" },
    sourceRecords: [
      {
        id: sourceRecordIds[0],
        sourceIdentity: "fanbox",
        coverage: { id: "fanbox.creator-post-summaries" },
      },
      {
        id: sourceRecordIds[1],
        sourceIdentity: "fanbox",
        coverage: { id: "fanbox.post-detail" },
      },
    ],
    accepted: {
      entity: { id: `asset-${index}` },
      sourceAssociations: [
        {
          sourceIdentity: "fanbox",
          nativeAddress: `https://www.fanbox.cc/@customudon/posts/${post.sourceNativeAddress}`,
        },
      ],
      recognitionSourceAssociation: {
        sourceIdentity: "fanbox",
        nativeAddress: `https://www.fanbox.cc/@customudon/posts/${post.sourceNativeAddress}`,
      },
      artifacts: [
        { id: artifactId },
        ...(post.cover === "present" ? [{ id: managedCoverArtifactId }] : []),
      ],
      artifactAssociations: [
        { artifactId, role: "asset.material-delivered" },
        ...(post.cover === "present"
          ? [
              {
                artifactId: managedCoverArtifactId,
                role: "asset.primary-cover",
                sourceRecordIds,
              },
            ]
          : []),
      ],
      locations: [
        { artifactId, kind: "observed" },
        ...(post.cover === "present"
          ? [{ artifactId: managedCoverArtifactId, kind: "managed" }]
          : []),
      ],
      blobs: [
        {
          digest: `sha256:observed-${index}`,
          mediaType: "application/json",
          byteLength: 1,
        },
      ],
      artifactRevisions: [
        {
          id: `revision-${index}`,
          artifactId,
          blobDigest: `sha256:observed-${index}`,
        },
      ],
      metadata: [
        ...(
          [
            [
              "asset.title",
              post.title,
              "fanbox.post.title",
              [sourceRecordIds[1]!],
            ],
            [
              "asset.publication-datetime",
              post.publishedDatetime,
              "fanbox.post.publication-datetime",
              [sourceRecordIds[1]!],
            ],
            [
              "fanbox.post.form",
              post.postType,
              "fanbox.post.form",
              [sourceRecordIds[1]!],
            ],
            [
              "fanbox.post.entitlement",
              post.entitlement,
              "fanbox.post.entitlement",
              [sourceRecordIds[1]!],
            ],
          ] as const
        ).map(([property, value, sourceSlot, factSourceRecordIds]) => ({
          property,
          value,
          sourceSlot,
          sourceRecordIds: factSourceRecordIds,
        })),
        {
          property: "asset.local-observation",
          value: `observed-${index}`,
          sourceSlot: "local.observation",
          sourceRecordIds: [],
          observedArtifactPart: {
            artifactId,
            revisionId: `revision-${index}`,
            locator: "metadata.json",
          },
        },
      ],
      sourceArtifactCandidates: [
        {
          sourceRecordId: sourceRecordIds[1],
          role: "asset.primary-cover",
          mediaType: "image/jpeg",
        },
      ],
      entities: [
        { id: "creator-1", sourceKey: post.creatorId, sourceRecordIds },
      ],
      entityMentions: [{ sourceRecordIds }],
      entityResolutionDecisions: [{ sourceRecordIds }],
      relationships: [{ sourceRecordIds }],
    },
  };
}

function refreshedInspectionWithRetainedFacts(
  post: FanboxPostOracle,
  index: number,
): unknown {
  const refreshed = structuredClone(acceptedInspection(post, index)) as {
    sourceRecords: Array<{ id: string }>;
    accepted: { relationships: MutableSourcedFact[] };
  };
  refreshed.sourceRecords[0]!.id = `refresh-summary-${index}`;
  refreshed.sourceRecords[1]!.id = `refresh-detail-${index}`;
  refreshed.accepted.relationships.push({
    sourceRecordIds: [`refresh-detail-${index}`],
  });
  return refreshed;
}

type MutableSourcedFact = { sourceRecordIds: string[] };
type MutableInspection = FanboxJourneyInspection & {
  sourceRecords: Array<{
    id: string;
    sourceIdentity: string;
    coverage: { id: string };
  }>;
  accepted: NonNullable<FanboxJourneyInspection["accepted"]> & {
    metadata: Array<
      MutableSourcedFact & {
        property: string;
        sourceSlot: string;
        value: string;
      }
    >;
    entities: MutableSourcedFact[];
    entityMentions: MutableSourcedFact[];
    entityResolutionDecisions: MutableSourcedFact[];
    relationships: MutableSourcedFact[];
    sourceArtifactCandidates: Array<{ sourceRecordId: string }>;
    artifactAssociations: Array<{ sourceRecordIds?: string[] }>;
  };
};

function mutableInspection(value: unknown): MutableInspection {
  return structuredClone(value) as MutableInspection;
}

function malformedMetadataInspections(
  post: FanboxPostOracle,
): readonly unknown[] {
  const withoutObservedPart = structuredClone(acceptedInspection(post, 1)) as {
    accepted: { metadata: Record<string, unknown>[] };
  };
  delete withoutObservedPart.accepted.metadata.at(-1)!.observedArtifactPart;

  const unknownRevision = structuredClone(acceptedInspection(post, 1)) as {
    accepted: { metadata: Record<string, unknown>[] };
  };
  unknownRevision.accepted.metadata.at(-1)!.observedArtifactPart = {
    artifactId: "observed-1",
    revisionId: "unknown-revision",
    locator: "metadata.json",
  };

  const forgedSourceFact = structuredClone(acceptedInspection(post, 1)) as {
    accepted: { metadata: Record<string, unknown>[] };
  };
  forgedSourceFact.accepted.metadata.push({
    property: "fanbox.post.like-count",
    value: "10",
    sourceSlot: "local.observation",
    sourceRecordIds: [],
    observedArtifactPart: {
      artifactId: "observed-1",
      revisionId: "revision-1",
      locator: "metadata.json",
    },
  });

  const mixedProvenance = structuredClone(acceptedInspection(post, 1)) as {
    accepted: { metadata: Array<{ sourceRecordIds: string[] }> };
  };
  mixedProvenance.accepted.metadata.at(-1)!.sourceRecordIds = ["detail-1"];

  return [
    withoutObservedPart,
    unknownRevision,
    forgedSourceFact,
    mixedProvenance,
  ];
}

function successfulResults(
  context: CliJourneyContext,
  posts: readonly FanboxPostOracle[],
): readonly CliJourneyResult[] {
  const results = commandResults(context, posts, 21);
  for (const [index, post] of posts.entries()) {
    const initial = acceptedInspection(post, index + 1) as Record<
      string,
      unknown
    >;
    results[6 + index] = {
      ...results[6 + index]!,
      stdout: JSON.stringify(initial),
    };
    results[11 + index] = {
      ...results[11 + index]!,
      stdout: JSON.stringify({
        ...initial,
        execution: { outcome: "no-change" },
        sourceRecords: [],
      }),
    };
    results[16 + index] = {
      ...results[16 + index]!,
      stdout: JSON.stringify(
        refreshedInspectionWithRetainedFacts(post, index + 1),
      ),
    };
  }
  return results;
}

async function evidenceLines(
  pathname: string,
): Promise<readonly Record<string, unknown>[]> {
  const contents = await readFile(pathname, "utf8");
  if (!contents.endsWith("\n")) throw new Error("证据日志缺少末尾换行");
  return contents
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function recoverableCause(
  pathname: string,
): Promise<Record<string, unknown>> {
  const contents = await readFile(pathname, "utf8");
  const boundary = contents.indexOf("\n");
  if (boundary < 0) throw new Error("证据日志没有完整首因行");
  return JSON.parse(contents.slice(0, boundary)) as Record<string, unknown>;
}

function errorContains(caught: unknown, sentinel: string): boolean {
  expect(caught).toBeInstanceOf(Error);
  const assertion = caught as Error & {
    actual?: unknown;
    expected?: unknown;
    cause?: unknown;
  };
  return [
    assertion.message,
    assertion.stack,
    JSON.stringify(assertion.actual),
    JSON.stringify(assertion.expected),
    JSON.stringify(assertion.cause),
    assertion.cause instanceof Error ? assertion.cause.message : undefined,
  ]
    .join("\n")
    .includes(sentinel);
}

describe("FANBOX 实时失败诊断", () => {
  it("setup ownership routing 错误不会携带 ownerTicket 原值", async () => {
    const sentinel = "private-owner-ticket-sentinel";
    let caught: unknown;
    try {
      await syntheticJourney({ ownerTicket: sentinel });
    } catch (error) {
      caught = error;
    }

    expect(errorContains(caught, sentinel)).toBe(false);
    const routingError = caught as Error & { cause?: unknown };
    expect(routingError.message).toBe(
      "FANBOX fixed-corpus ownership routing is invalid",
    );
    expect(routingError.cause).toBeUndefined();
  });

  it("允许 refresh 同值事实保留 initial 来源证明", () => {
    const post = reviewedPost(1);
    const initial = acceptedInspection(post, 1);
    const refreshed = refreshedInspectionWithRetainedFacts(post, 1);

    expect(() =>
      assertFanboxRefreshedPost(
        initial as Parameters<typeof assertFanboxRefreshedPost>[0],
        refreshed as Parameters<typeof assertFanboxRefreshedPost>[1],
        post,
      ),
    ).not.toThrow();
  });

  it("拒绝 refresh 重复消费同一个 initial 来源事实", () => {
    const post = reviewedPost(1);
    const initial = acceptedInspection(post, 1);
    const refreshed = refreshedInspectionWithRetainedFacts(post, 1);
    const mutableRefreshed = refreshed as {
      accepted: { relationships: MutableSourcedFact[] };
    };
    mutableRefreshed.accepted.relationships.push(
      structuredClone(mutableRefreshed.accepted.relationships[0]!),
    );

    expect(() =>
      assertFanboxRefreshedPost(
        initial as Parameters<typeof assertFanboxRefreshedPost>[0],
        refreshed as Parameters<typeof assertFanboxRefreshedPost>[1],
        post,
      ),
    ).toThrow("FANBOX refresh relationship provenance is invalid");
  });

  it("拒绝无效的 FANBOX 两代来源记录与投影事实证明", () => {
    const post = reviewedPost(1);
    const invalidInitialRecords: Array<(value: MutableInspection) => void> = [
      (value) => {
        value.sourceRecords[0]!.id = " ";
      },
      (value) => {
        value.sourceRecords[1]!.id = value.sourceRecords[0]!.id;
      },
      (value) => {
        value.sourceRecords[0]!.sourceIdentity = "other-source";
      },
      (value) => {
        value.sourceRecords[1]!.coverage.id = "fanbox.creator-post-summaries";
      },
      (value) => {
        expect(Reflect.deleteProperty(value.sourceRecords, 0)).toBe(true);
      },
    ];
    for (const mutate of invalidInitialRecords) {
      const value = mutableInspection(acceptedInspection(post, 1));
      mutate(value);
      expect(() =>
        assertFanboxAcceptedPost(
          value as Parameters<typeof assertFanboxAcceptedPost>[0],
          post,
        ),
      ).toThrow();
    }

    const invalidInitialFacts: Array<
      readonly [string, (value: MutableInspection) => void]
    > = [
      [
        "metadata",
        (value) => {
          value.accepted.metadata[0]!.sourceRecordIds = [
            "detail-1",
            "unknown-record",
          ];
        },
      ],
      [
        "entity",
        (value) => {
          value.accepted.entities[0]!.sourceRecordIds = ["unknown-record"];
        },
      ],
      [
        "entity-mention",
        (value) => {
          value.accepted.entityMentions[0]!.sourceRecordIds = [" "];
        },
      ],
      [
        "entity-resolution-decision",
        (value) => {
          value.accepted.entityResolutionDecisions[0]!.sourceRecordIds = [
            "unknown-record",
          ];
        },
      ],
      [
        "relationship",
        (value) => {
          value.accepted.relationships[0]!.sourceRecordIds = ["unknown-record"];
        },
      ],
      [
        "source-artifact-candidate",
        (value) => {
          value.accepted.sourceArtifactCandidates[0]!.sourceRecordId =
            "unknown-record";
        },
      ],
    ];
    for (const [kind, mutate] of invalidInitialFacts) {
      const value = mutableInspection(acceptedInspection(post, 1));
      mutate(value);
      expect(() =>
        assertFanboxAcceptedPost(
          value as Parameters<typeof assertFanboxAcceptedPost>[0],
          post,
        ),
      ).toThrow(`FANBOX initial ${kind} provenance is invalid`);
    }

    const sparseFact = mutableInspection(acceptedInspection(post, 1));
    expect(
      Reflect.deleteProperty(
        sparseFact.accepted.entities[0]!.sourceRecordIds,
        0,
      ),
    ).toBe(true);
    expect(() =>
      assertFanboxAcceptedPost(
        sparseFact as Parameters<typeof assertFanboxAcceptedPost>[0],
        post,
      ),
    ).toThrow("must not be sparse");

    const coverPost = { ...post, cover: "present" as const };
    const invalidAssociation = mutableInspection(
      acceptedInspection(coverPost, 1),
    );
    const associationIndex =
      invalidAssociation.accepted.artifactAssociations.length - 1;
    invalidAssociation.accepted.artifactAssociations[associationIndex] = {
      ...invalidAssociation.accepted.artifactAssociations[associationIndex]!,
      sourceRecordIds: ["unknown-record"],
    };
    expect(() =>
      assertFanboxAcceptedPost(
        invalidAssociation as Parameters<typeof assertFanboxAcceptedPost>[0],
        coverPost,
      ),
    ).toThrow("FANBOX initial artifact-association provenance is invalid");

    const reusedGeneration = mutableInspection(
      refreshedInspectionWithRetainedFacts(post, 1),
    );
    reusedGeneration.sourceRecords[0]!.id = "summary-1";
    expect(() =>
      assertFanboxRefreshedPost(
        acceptedInspection(post, 1) as Parameters<
          typeof assertFanboxRefreshedPost
        >[0],
        reusedGeneration as Parameters<typeof assertFanboxRefreshedPost>[1],
        post,
      ),
    ).toThrow("must not reuse initial ids");

    for (const mutate of [
      (value: MutableInspection) => {
        value.accepted.metadata.push({
          property: "fanbox.post.like-count",
          sourceSlot: "fanbox.post.like-count",
          value: "10",
          sourceRecordIds: ["detail-1"],
        });
      },
      (value: MutableInspection) => {
        value.accepted.metadata[0]!.sourceRecordIds = [
          "detail-1",
          "refresh-detail-1",
        ];
      },
    ]) {
      const invalidRefresh = mutableInspection(
        refreshedInspectionWithRetainedFacts(post, 1),
      );
      mutate(invalidRefresh);
      expect(() =>
        assertFanboxRefreshedPost(
          acceptedInspection(post, 1) as Parameters<
            typeof assertFanboxRefreshedPost
          >[0],
          invalidRefresh as Parameters<typeof assertFanboxRefreshedPost>[1],
          post,
        ),
      ).toThrow("FANBOX refresh metadata provenance is invalid");
    }
  });

  it("将 metadata-refresh 的非 accepted 结果归属到原 initial-accept", async () => {
    for (const scenario of [
      { accepted: undefined, prefixMutation: "none" },
      {
        accepted: { entity: { id: "stale-asset" } },
        prefixMutation: "none",
      },
      { accepted: undefined, prefixMutation: "sparse" },
      { accepted: undefined, prefixMutation: "truncated" },
    ]) {
      const subject = await syntheticJourney();
      process.env[evidenceEnvironment] = subject.evidencePath;
      const results = commandResults(subject.context, subject.posts, 16);
      results[6] = {
        ...results[6]!,
        stdout: JSON.stringify({
          format: "temporary-asset-refresh-inspection/v1",
          execution: {
            outcome: "partially-succeeded",
            stage: "failed",
            dispositions: [
              {
                key: "official-collection",
                sourceFailureCodes: [
                  {
                    capability: {
                      capabilityId: "fanbox.official-collection",
                      capabilityVersion: "2",
                      contractVersion: "1",
                      identity: "fanbox.official-collection",
                      implementationVersion: "2",
                      kind: "source-collector",
                      interpretationContractVersions: ["1"],
                    },
                    code: "http:post-detail:503",
                  },
                ],
              },
            ],
          },
          ...(scenario.accepted === undefined
            ? {}
            : { accepted: scenario.accepted }),
        }),
      };
      const refresh = journey.commands(subject.context)[16]!;
      expect(typeof refresh.args).toBe("function");
      expect(() =>
        (refresh.args as (previous: readonly CliJourneyResult[]) => unknown)(
          results,
        ),
      ).toThrow();
      if (scenario.prefixMutation === "sparse")
        expect(Reflect.deleteProperty(results, 2)).toBe(true);
      if (scenario.prefixMutation === "truncated") results.length = 7;

      await journey.teardown?.({ context: subject.context, results });

      const cause = (await evidenceLines(subject.evidencePath))[0];
      if (scenario.prefixMutation !== "none") {
        expect(cause).toMatchObject({
          stage: "teardown",
          cause: { category: "journey-output-invalid" },
        });
        continue;
      }
      expect(cause).toMatchObject({
        stage: "initial-accept",
        command: {
          ordinal: 7,
          name: "live accept FANBOX post 1001",
          post: { ordinal: 1, nativeAddress: "1001" },
          exitCode: 0,
        },
        inspection: {
          outcome: "partially-succeeded",
          workflowStage: "failed",
        },
        cause: { category: "http-status", status: 503, class: "5xx" },
      });
    }
  });

  it("接受同一结构化原因的重复观察并拒绝带额外字段的观察", async () => {
    const capability = {
      capabilityId: "fanbox.official-collection",
      capabilityVersion: "2",
      contractVersion: "1",
      identity: "fanbox.official-collection",
      implementationVersion: "2",
      kind: "source-collector",
      interpretationContractVersions: ["1"],
    };
    const run = async (
      sourceFailureCodes: unknown,
      trailingSourceFailureCodes?: unknown,
    ) => {
      const subject = await syntheticJourney();
      process.env[evidenceEnvironment] = subject.evidencePath;
      const results = commandResults(subject.context, subject.posts, 7);
      results[6] = {
        ...results[6]!,
        exitCode: 7,
        stdout: JSON.stringify({
          format: "temporary-asset-refresh-inspection/v1",
          execution: {
            outcome: "failed",
            stage: "failed",
            dispositions: [
              {
                key: "official-collection",
                status: "failed",
                sourceFailureCodes,
              },
              ...(trailingSourceFailureCodes === undefined
                ? []
                : [
                    {
                      key: "official-collection:trailing",
                      status: "failed",
                      sourceFailureCodes: trailingSourceFailureCodes,
                    },
                  ]),
            ],
          },
        }),
      };
      await journey.teardown?.({ context: subject.context, results });
      return (await evidenceLines(subject.evidencePath))[0]!.cause;
    };

    await expect(
      run([
        { capability, code: "http:creator-summaries:403" },
        { capability, code: "http:creator-summaries:403" },
      ]),
    ).resolves.toEqual({ category: "http-status", status: 403, class: "4xx" });
    await expect(
      run([
        {
          capability: { ...capability, adjacent: "must-not-be-ignored" },
          code: "http:creator-summaries:403",
        },
      ]),
    ).resolves.toEqual({ category: "unknown" });
    await expect(
      run([
        {
          capability: {
            ...capability,
            capabilityVersion: "1",
            implementationVersion: "1",
          },
          code: "http:creator-summaries:403",
        },
      ]),
    ).resolves.toEqual({ category: "unknown" });
    for (const malformed of [
      {},
      [],
      Array.from({ length: 17 }, () => ({
        capability,
        code: "http:creator-summaries:403",
      })),
    ]) {
      await expect(
        run(malformed, [{ capability, code: "http:creator-summaries:403" }]),
      ).resolves.toEqual({ category: "unknown" });
    }
  });

  it("使用超过 2,000 字符后的完整检查结果分类且不复制原始材料", async () => {
    const subject = await syntheticJourney();
    process.env[evidenceEnvironment] = subject.evidencePath;
    const results = commandResults(subject.context, subject.posts, 7);
    const reason = "FANBOX official source request failed: HTTP 403";
    const stdout = JSON.stringify({
      format: "temporary-asset-refresh-inspection/v1",
      discarded:
        "FANBOXSESSID=fake-secret /private/source/path authorization cookie 正文".padEnd(
          2_200,
          "x",
        ),
      execution: {
        outcome: "failed",
        stage: "failed",
        reason,
        dispositions: [
          {
            key: "official-collection",
            status: "failed",
            sourceFailureCodes: [
              {
                capability: {
                  capabilityId: "fanbox.official-collection",
                  capabilityVersion: "2",
                  contractVersion: "1",
                  identity: "fanbox.official-collection",
                  implementationVersion: "2",
                  kind: "source-collector",
                  interpretationContractVersions: ["1"],
                },
                code: "http:creator-summaries:403",
              },
            ],
          },
        ],
      },
      sourceRecords: [{ body: "must never be copied" }],
    });
    expect(stdout.indexOf(reason)).toBeGreaterThan(2_000);
    results[6] = { ...results[6]!, exitCode: 7, stdout };

    await journey.teardown?.({ context: subject.context, results });

    const serialized = await readFile(subject.evidencePath, "utf8");
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(4_096);
    expect(
      serialized
        .slice(0, -1)
        .split("\n")
        .every((line) => Buffer.byteLength(`${line}\n`) <= 2_048),
    ).toBe(true);
    expect(serialized).not.toMatch(
      /FANBOXSESSID|fake-secret|private\/source|authorization|cookie|正文|discarded|sourceRecords|must never/iu,
    );
    const [cause, finished] = await evidenceLines(subject.evidencePath);
    expect(cause).toEqual({
      format: "fanbox-live-failure/1",
      evidenceState: "cause-persisted",
      mode: "source",
      journey: "fanbox-five-live",
      stage: "initial-accept",
      command: {
        ordinal: 7,
        name: "live accept FANBOX post 1001",
        post: { ordinal: 1, nativeAddress: "1001" },
        exitCode: 7,
      },
      inspection: { outcome: "failed", workflowStage: "failed" },
      cause: { category: "http-status", status: 403, class: "4xx" },
      teardown: "pending",
      stateReleased: "pending",
    });
    expect(finished).toEqual({
      format: "fanbox-live-failure/1",
      evidenceState: "teardown-finished",
      mode: "source",
      journey: "fanbox-five-live",
      stage: "initial-accept",
      command: {
        ordinal: 7,
        name: "live accept FANBOX post 1001",
        post: { ordinal: 1, nativeAddress: "1001" },
        exitCode: 7,
      },
      inspection: { outcome: "failed", workflowStage: "failed" },
      cause: { category: "http-status", status: 403, class: "4xx" },
      teardown: "passed",
      stateReleased: "yes",
    });
    expect((await lstat(subject.evidencePath)).mode & 0o777).toBe(0o600);
  });

  it("在媒体核对前持久化原因，并在漂移导致收尾失败时释放状态", async () => {
    const subject = await syntheticJourney();
    process.env[evidenceEnvironment] = subject.evidencePath;
    const results = commandResults(subject.context, subject.posts, 7);
    results[6] = {
      ...results[6]!,
      exitCode: 9,
      stdout: JSON.stringify({
        format: "temporary-asset-refresh-inspection/v1",
        execution: {
          outcome: "failed",
          stage: "failed",
          reason: "FANBOX official source request failed: HTTP 503",
          dispositions: [
            {
              key: "official-collection",
              status: "failed",
              sourceFailureCodes: [
                {
                  capability: {
                    capabilityId: "fanbox.official-collection",
                    capabilityVersion: "2",
                    contractVersion: "1",
                    identity: "fanbox.official-collection",
                    implementationVersion: "2",
                    kind: "source-collector",
                    interpretationContractVersions: ["1"],
                  },
                  code: "http:creator-summaries:503",
                },
              ],
            },
          ],
        },
      }),
    };

    const mutateAfterCause = (async () => {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        try {
          if (
            (await recoverableCause(subject.evidencePath)).evidenceState ===
            "cause-persisted"
          ) {
            await writeFile(subject.mediaFile, "media-drift-after-cause");
            return;
          }
        } catch {}
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("媒体核对前未观察到 cause-persisted");
    })();
    const teardownResult = journey
      .teardown?.({ context: subject.context, results })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    await mutateAfterCause;
    expect(await teardownResult).toBeInstanceOf(Error);
    expect((await evidenceLines(subject.evidencePath))[1]).toMatchObject({
      evidenceState: "teardown-finished",
      cause: { category: "http-status", status: 503, class: "5xx" },
      teardown: "failed",
      stateReleased: "yes",
    });
    await expect(
      journey.teardown?.({ context: subject.context, results }),
    ).resolves.toBeUndefined();

    delete process.env[evidenceEnvironment];
    const missingPath = await syntheticJourney();
    const missingPathResults = commandResults(
      missingPath.context,
      missingPath.posts,
      7,
    );
    missingPathResults[6] = { ...missingPathResults[6]!, exitCode: 1 };
    await writeFile(missingPath.mediaFile, "drift-without-evidence-path");
    const missingPathFailure = await journey
      .teardown?.({ context: missingPath.context, results: missingPathResults })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(missingPathFailure).toBeInstanceOf(AggregateError);
    expect(
      (missingPathFailure as AggregateError).errors.map(String).join("\n"),
    ).toMatch(/必须提供 FANBOX 失败证据路径[\s\S]*单根条目签名/u);
    await expect(
      journey.teardown?.({
        context: missingPath.context,
        results: missingPathResults,
      }),
    ).resolves.toBeUndefined();

    const interrupted = await syntheticJourney();
    process.env[evidenceEnvironment] = interrupted.evidencePath;
    const interruptedResults = commandResults(
      interrupted.context,
      interrupted.posts,
      7,
    );
    interruptedResults[6] = {
      ...interruptedResults[6]!,
      exitCode: 8,
      stdout: JSON.stringify({
        format: "temporary-asset-refresh-inspection/v1",
        execution: {
          outcome: "failed",
          reason: "FANBOX official source request failed: HTTP 502",
          dispositions: [
            {
              key: "official-collection",
              status: "failed",
              sourceFailureCodes: [
                {
                  capability: {
                    capabilityId: "fanbox.official-collection",
                    capabilityVersion: "2",
                    contractVersion: "1",
                    identity: "fanbox.official-collection",
                    implementationVersion: "2",
                    kind: "source-collector",
                    interpretationContractVersions: ["1"],
                  },
                  code: "http:creator-summaries:502",
                },
              ],
            },
          ],
        },
      }),
    };
    const injectTrailingBytes = (async () => {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        try {
          if (
            (await recoverableCause(interrupted.evidencePath)).evidenceState ===
            "cause-persisted"
          ) {
            await appendFile(interrupted.evidencePath, '{"partial":');
            await chmod(interrupted.evidencePath, 0o400);
            return;
          }
        } catch {}
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("追加前未观察到 cause-persisted");
    })();
    const interruptedTeardown = journey
      .teardown?.({ context: interrupted.context, results: interruptedResults })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await injectTrailingBytes;
    expect(await interruptedTeardown).toBeInstanceOf(Error);
    await chmod(interrupted.evidencePath, 0o600);
    expect(await recoverableCause(interrupted.evidencePath)).toMatchObject({
      evidenceState: "cause-persisted",
      cause: { category: "http-status", status: 502, class: "5xx" },
      teardown: "pending",
      stateReleased: "pending",
    });
    await expect(evidenceLines(interrupted.evidencePath)).rejects.toThrow(
      "证据日志缺少末尾换行",
    );
    await expect(
      journey.teardown?.({
        context: interrupted.context,
        results: interruptedResults,
      }),
    ).resolves.toBeUndefined();
  });

  it("将结果错序和命令名称漂移映射为 journey-output-invalid", async () => {
    const subject = await syntheticJourney();
    process.env[evidenceEnvironment] = subject.evidencePath;
    const results = commandResults(subject.context, subject.posts, 7);
    [results[1], results[2]] = [results[2]!, results[1]!];
    results[6] = {
      ...results[6]!,
      commandName: "drifted command name with /private/path",
      exitCode: 3,
      stdout: "not trusted",
    };

    await journey.teardown?.({ context: subject.context, results });

    expect((await evidenceLines(subject.evidencePath))[1]).toEqual({
      format: "fanbox-live-failure/1",
      evidenceState: "teardown-finished",
      mode: "source",
      journey: "fanbox-five-live",
      stage: "teardown",
      cause: { category: "journey-output-invalid" },
      teardown: "passed",
      stateReleased: "yes",
    });

    for (const malformed of ["empty", "short", "extra", "drift"] as const) {
      const malformedSubject = await syntheticJourney();
      process.env[evidenceEnvironment] = malformedSubject.evidencePath;
      const all = commandResults(
        malformedSubject.context,
        malformedSubject.posts,
        21,
      );
      const malformedResults =
        malformed === "empty"
          ? []
          : malformed === "short"
            ? all.slice(0, 6)
            : malformed === "extra"
              ? [...all, { ...all[20]!, commandName: "extra command" }]
              : all.map((result, index) =>
                  index === 3
                    ? { ...result, commandName: "drifted zero command" }
                    : result,
                );
      await journey.teardown?.({
        context: malformedSubject.context,
        results: malformedResults,
      });
      expect((await evidenceLines(malformedSubject.evidencePath))[1]).toEqual({
        format: "fanbox-live-failure/1",
        evidenceState: "teardown-finished",
        mode: "source",
        journey: "fanbox-five-live",
        stage: "teardown",
        cause: { category: "journey-output-invalid" },
        teardown: "passed",
        stateReleased: "yes",
      });
    }
  });

  it("拒绝缺失或伪造的 FANBOX metadata 证据链", () => {
    const post = reviewedPost(1);

    for (const inspection of malformedMetadataInspections(post))
      expect(() =>
        assertFanboxAcceptedPost(
          inspection as Parameters<typeof assertFanboxAcceptedPost>[0],
          post,
        ),
      ).toThrow();
  });

  it.each([
    [
      "outcome",
      (value: MutableInspection, sentinel: string) => {
        (value.execution as { outcome: string }).outcome = sentinel;
      },
    ],
    [
      "source identity",
      (value: MutableInspection, sentinel: string) => {
        value.sourceRecords[0]!.sourceIdentity = sentinel;
      },
    ],
    [
      "coverage",
      (value: MutableInspection, sentinel: string) => {
        value.sourceRecords[0]!.coverage.id = sentinel;
      },
    ],
  ] as const)("%s 错误对象不会携带 inspection 原值", (_label, mutate) => {
    const sentinel = "private-inspection-sentinel";
    const post = reviewedPost(1);
    const value = mutableInspection(acceptedInspection(post, 1));
    mutate(value, sentinel);

    let caught: unknown;
    try {
      assertFanboxAcceptedPost(
        value as Parameters<typeof assertFanboxAcceptedPost>[0],
        post,
      );
    } catch (error) {
      caught = error;
    }
    expect(errorContains(caught, sentinel)).toBe(false);
  });

  it("业务断言错误对象不会携带来源值", async () => {
    const titleSentinel = "private-title-sentinel";
    const post = reviewedPost(1);
    const value = acceptedInspection(post, 1) as MutableInspection;
    const titleFact = value.accepted.metadata.find(
      (fact) => fact.property === "asset.title",
    ) as unknown as { value: string };
    titleFact.value = titleSentinel;

    let titleError: unknown;
    try {
      assertFanboxAcceptedPost(
        value as Parameters<typeof assertFanboxAcceptedPost>[0],
        post,
      );
    } catch (error) {
      titleError = error;
    }
    expect(errorContains(titleError, titleSentinel)).toBe(false);

    const stderrSentinel = "private-stderr-sentinel";
    const subject = await syntheticJourney();
    process.env[evidenceEnvironment] = subject.evidencePath;
    const results = successfulResults(subject.context, subject.posts).map(
      (result) => ({ ...result }),
    );
    results[0] = {
      ...results[0]!,
      exitCode: 1,
      stderr: stderrSentinel,
    };
    let commandError: unknown;
    try {
      await journey.assertions({ context: subject.context, results });
    } catch (error) {
      commandError = error;
    }
    expect(errorContains(commandError, stderrSentinel)).toBe(false);
    await journey.teardown?.({ context: subject.context, results });
  });

  it("没有证据路径时仍保持成功业务断言与收尾正常运行", async () => {
    const failedAssertions = await syntheticJourney();
    process.env[evidenceEnvironment] = failedAssertions.evidencePath;
    const invalidResults = successfulResults(
      failedAssertions.context,
      failedAssertions.posts,
    ).map((result) => ({ ...result }));
    const invalidInspection = JSON.parse(invalidResults[6]!.stdout) as Record<
      string,
      unknown
    >;
    invalidInspection.execution = { outcome: "no-change" };
    invalidResults[6] = {
      ...invalidResults[6]!,
      stdout: JSON.stringify(invalidInspection),
    };
    await expect(
      journey.assertions({
        context: failedAssertions.context,
        results: invalidResults,
      }),
    ).rejects.toThrow();
    await journey.teardown?.({
      context: failedAssertions.context,
      results: invalidResults,
    });
    expect((await evidenceLines(failedAssertions.evidencePath))[1]).toEqual({
      format: "fanbox-live-failure/1",
      evidenceState: "teardown-finished",
      mode: "source",
      journey: "fanbox-five-live",
      stage: "assertions",
      cause: { category: "journey-output-invalid" },
      teardown: "passed",
      stateReleased: "yes",
    });

    delete process.env[evidenceEnvironment];
    const subject = await syntheticJourney();
    const results = successfulResults(subject.context, subject.posts);

    await expect(
      journey.assertions({ context: subject.context, results }),
    ).resolves.toBeUndefined();
    await expect(
      journey.teardown?.({ context: subject.context, results }),
    ).resolves.toBeUndefined();
    await expect(lstat(subject.evidencePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
