import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AssetRefreshInspection } from "@digital/application";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertBangumiAcceptedEpisodeSet,
  assertBangumiReopenedEpisodeSet,
  type BangumiEpisodicRootOracle,
  default as journey,
} from "../e2e/journeys/bangumi-episodic-live.journey.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

const oracle: BangumiEpisodicRootOracle = {
  title: "示例作品",
  subjects: [{ season: 1, sourceAddress: "100" }],
  episodes: [
    {
      season: 1,
      seasonPosition: 1,
      continuousPosition: 1,
      sourceAddress: "1001",
    },
    {
      season: 1,
      seasonPosition: 2,
      continuousPosition: 2,
      sourceAddress: "1002",
    },
  ],
};

const multiSeasonOracle: BangumiEpisodicRootOracle = {
  title: "示例作品",
  subjects: [
    { season: 1, sourceAddress: "100" },
    { season: 2, sourceAddress: "200" },
  ],
  episodes: [
    {
      season: 1,
      seasonPosition: 1,
      continuousPosition: 1,
      sourceAddress: "1001",
    },
    {
      season: 2,
      seasonPosition: 1,
      continuousPosition: 2,
      sourceAddress: "1002",
    },
  ],
};

function inspection(
  addresses: readonly ["1001" | "1002", "1001" | "1002"],
): AssetRefreshInspection {
  const sourceRecords = [
    {
      id: "search-record",
      sourceIdentity: "bangumi",
      nativeAddress: "bangumi:search:%E7%A4%BA%E4%BE%8B%E4%BD%9C%E5%93%81:2026",
      coverage: {
        id: "bangumi.subject-search",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      acquiredAt: "2026-08-29T00:00:00.000Z",
      digest: "search",
    },
    {
      id: "subject-record",
      sourceIdentity: "bangumi",
      nativeAddress: "https://bgm.tv/subject/100",
      coverage: {
        id: "bangumi.subject:100",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      acquiredAt: "2026-08-29T00:00:00.000Z",
      digest: "subject",
    },
    {
      id: "relationship-record",
      sourceIdentity: "bangumi",
      nativeAddress: "https://bgm.tv/subject/100",
      coverage: {
        id: "bangumi.relationships:100",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      acquiredAt: "2026-08-29T00:00:00.000Z",
      digest: "relationships",
    },
    {
      id: "episode-page-record",
      sourceIdentity: "bangumi",
      nativeAddress: "https://bgm.tv/subject/100",
      coverage: {
        id: "bangumi.ordinary-episodes:100:0",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      acquiredAt: "2026-08-29T00:00:00.000Z",
      digest: "episodes",
    },
    ...["1001", "1002"].map((address) => ({
      id: `episode-record-${address}`,
      sourceIdentity: "bangumi",
      nativeAddress: `https://bgm.tv/episode/${address}`,
      coverage: {
        id: `bangumi.episode:${address}`,
        completeness: "complete" as const,
        authority: "official" as const,
      },
      acquiredAt: "2026-08-29T00:00:00.000Z",
      digest: address,
    })),
  ];
  const itemResults = addresses.map((address) => {
    const position = Number(address) - 1000;
    const entityId = `episode-${address}`;
    const artifactId = `artifact-${address}`;
    const subjectId = "subject-100";
    return {
      key: `bangumi:episode:${JSON.stringify([".", 1, position])}`,
      relativePaths: [
        `Season 1/示例作品 - S01E${String(position).padStart(2, "0")} - 第 ${position} 集.mkv`,
      ],
      outcome: "accepted" as const,
      accepted: {
        entity: { id: entityId, kind: "digital-asset" as const },
        recognitionSourceAssociation: {
          sourceIdentity: "bangumi",
          nativeAddress: `https://bgm.tv/episode/${address}`,
        },
        sourceAssociations: [
          {
            sourceIdentity: "bangumi",
            nativeAddress: `https://bgm.tv/episode/${address}`,
          },
        ],
        metadata: [
          {
            id: `season-position-${address}`,
            target: { kind: "entity", entityId },
            property: "bangumi.episode.season-position",
            value: String(position),
            sourceSlot: "bangumi.episode.ep",
            sourceRecordIds: ["episode-page-record"],
          },
          {
            id: `continuous-position-${address}`,
            target: { kind: "entity", entityId },
            property: "bangumi.episode.continuous-position",
            value: String(position),
            sourceSlot: "bangumi.episode.sort",
            sourceRecordIds: ["episode-page-record"],
          },
        ],
        currentRelatedEntities: [
          {
            id: subjectId,
            kind: { status: "ordinary" as const },
            sourceIdentity: "bangumi",
            identityNamespace: "bangumi.subject",
            sourceKey: "100",
            label: "示例作品",
            sourceRecordIds: ["subject-record"],
          },
        ],
        relationships: [
          {
            id: `membership-${address}`,
            participants: [
              { entityId, role: "asset" },
              {
                entityId: subjectId,
                role: "bangumi.subject.ordinary-episode",
              },
            ],
            type: "asset.membership",
            sourceSlot: `bangumi.subject.ordinary-episode:100:${address}`,
            sourceRecordIds: ["subject-record", "episode-page-record"],
            qualifiers: [
              {
                key: "bangumi.episode.season-position",
                value: String(position),
              },
              {
                key: "bangumi.episode.continuous-position",
                value: String(position),
              },
            ],
          },
        ],
        artifacts: [{ id: artifactId }],
        locations: [
          {
            id: `location-${address}`,
            artifactId,
            address: `/observed/${address}.mkv`,
            kind: "observed" as const,
          },
        ],
        blobs: [],
        artifactRevisions: [],
        artifactAssociations: [
          {
            id: `association-${address}`,
            target: { kind: "entity", entityId },
            artifactId,
            role: "asset.material-delivered",
          },
        ],
        effectiveMetadata: [],
        metadataPolicyConflicts: [],
        recognitionExplanation: "Bangumi v1",
      },
    };
  });
  return {
    execution: {
      id: "execution",
      selection: { intent: "scan-now" },
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      sourceRecordIds: sourceRecords.map((record) => record.id),
      dispositions: [],
    },
    sourceRecords,
    itemResults,
  } as unknown as AssetRefreshInspection;
}

function multiSeasonInspection(): AssetRefreshInspection {
  const value = structuredClone(inspection(["1001", "1002"]));
  (
    value as unknown as {
      sourceRecords: AssetRefreshInspection["sourceRecords"][number][];
    }
  ).sourceRecords.push(
    {
      id: "subject-record-200",
      sourceIdentity: "bangumi",
      nativeAddress: "https://bgm.tv/subject/200",
      coverage: {
        id: "bangumi.subject:200",
        completeness: "complete",
        authority: "official",
      },
      acquiredAt: "2026-08-30T00:00:00.000Z",
      digest: "subject-200",
    },
    {
      id: "relationship-record-200",
      sourceIdentity: "bangumi",
      nativeAddress: "https://bgm.tv/subject/200",
      coverage: {
        id: "bangumi.relationships:200",
        completeness: "complete",
        authority: "official",
      },
      acquiredAt: "2026-08-30T00:00:00.000Z",
      digest: "relationships-200",
    },
    {
      id: "episode-page-record-200",
      sourceIdentity: "bangumi",
      nativeAddress: "https://bgm.tv/subject/200",
      coverage: {
        id: "bangumi.ordinary-episodes:200:0",
        completeness: "complete",
        authority: "official",
      },
      acquiredAt: "2026-08-30T00:00:00.000Z",
      digest: "episodes-200",
    },
  );
  const [season1, season2] = value.itemResults ?? [];
  for (const item of [season1, season2]) {
    if (item?.accepted === undefined) continue;
    (
      item.accepted as unknown as {
        currentRelatedEntities: Record<string, unknown>[];
      }
    ).currentRelatedEntities.push({
      id: "subject-200",
      kind: { status: "ordinary" },
      sourceIdentity: "bangumi",
      identityNamespace: "bangumi.subject",
      sourceKey: "200",
      label: "示例作品 第二季",
      sourceRecordIds: ["subject-record-200"],
    });
    (
      item.accepted as unknown as {
        relationships: Record<string, unknown>[];
      }
    ).relationships.push({
      id: "sequel-100-200",
      participants: [
        { entityId: "subject-100", role: "bangumi.subject.predecessor" },
        { entityId: "subject-200", role: "bangumi.subject.sequel" },
      ],
      type: "bangumi.subject.related",
      sourceSlot: "bangumi.subject.sequel:100:200",
      sourceRecordIds: ["relationship-record"],
    });
  }
  if (season2?.accepted !== undefined) {
    (season2 as { key: string; relativePaths: string[] }).key =
      `bangumi:episode:${JSON.stringify([".", 2, 1])}`;
    (season2 as { key: string; relativePaths: string[] }).relativePaths = [
      "Season 2/示例作品 - S02E01 - 第 1 集.mkv",
    ];
    for (const metadata of season2.accepted.metadata) {
      const mutableMetadata = metadata as unknown as {
        value: string;
        sourceRecordIds: string[];
      };
      if (metadata.property === "bangumi.episode.season-position")
        mutableMetadata.value = "1";
      if (metadata.property === "bangumi.episode.continuous-position")
        mutableMetadata.value = "2";
      mutableMetadata.sourceRecordIds = ["episode-page-record-200"];
    }
    const membership = season2.accepted.relationships?.find(
      (relationship) => relationship.type === "asset.membership",
    );
    if (membership !== undefined) {
      const mutableMembership = membership as unknown as {
        participants: { entityId: string; role: string }[];
        sourceSlot: string;
        sourceRecordIds: string[];
        qualifiers: { key: string; value: string }[];
      };
      const seasonParticipant = mutableMembership.participants.find(
        (participant) =>
          participant.role === "bangumi.subject.ordinary-episode",
      );
      if (seasonParticipant !== undefined)
        seasonParticipant.entityId = "subject-200";
      mutableMembership.sourceSlot =
        "bangumi.subject.ordinary-episode:200:1002";
      mutableMembership.sourceRecordIds = [
        "subject-record-200",
        "episode-page-record-200",
      ];
      const seasonPosition = membership.qualifiers?.find(
        (qualifier) => qualifier.key === "bangumi.episode.season-position",
      );
      const continuousPosition = membership.qualifiers?.find(
        (qualifier) => qualifier.key === "bangumi.episode.continuous-position",
      );
      if (seasonPosition !== undefined)
        (seasonPosition as { value: string }).value = "1";
      if (continuousPosition !== undefined)
        (continuousPosition as { value: string }).value = "2";
    }
  }
  return value;
}

describe("Bangumi episodic live journey contract", () => {
  it("requires the complete reviewed season chain in every final episode projection", () => {
    expect(() =>
      assertBangumiAcceptedEpisodeSet(
        multiSeasonInspection(),
        multiSeasonOracle,
      ),
    ).not.toThrow();

    const thirdSubject = multiSeasonInspection();
    const firstAccepted = thirdSubject.itemResults?.[0]?.accepted;
    if (firstAccepted !== undefined)
      (
        firstAccepted as unknown as {
          currentRelatedEntities: Record<string, unknown>[];
        }
      ).currentRelatedEntities.push({
        id: "subject-300",
        kind: { status: "ordinary" },
        sourceIdentity: "bangumi",
        identityNamespace: "bangumi.subject",
        sourceKey: "300",
        label: "非法第三季",
        sourceRecordIds: ["subject-record-200"],
      });
    expect(() =>
      assertBangumiAcceptedEpisodeSet(thirdSubject, multiSeasonOracle),
    ).toThrow(/exact reviewed Bangumi subjects/u);

    const missingSequel = multiSeasonInspection();
    const missingRelationships =
      missingSequel.itemResults?.[0]?.accepted?.relationships;
    if (missingRelationships !== undefined)
      (
        missingRelationships as unknown as {
          splice(start: number, count: number): void;
        }
      ).splice(1, 1);
    expect(() =>
      assertBangumiAcceptedEpisodeSet(missingSequel, multiSeasonOracle),
    ).toThrow(/sequel/u);

    const reversedSequel = multiSeasonInspection();
    const reversed =
      reversedSequel.itemResults?.[0]?.accepted?.relationships?.find(
        (relationship) =>
          relationship.participants.some(
            (participant) => participant.role === "bangumi.subject.sequel",
          ),
      );
    if (reversed !== undefined) {
      const predecessor = reversed.participants.find(
        (participant) => participant.role === "bangumi.subject.predecessor",
      );
      const successor = reversed.participants.find(
        (participant) => participant.role === "bangumi.subject.sequel",
      );
      if (predecessor !== undefined && successor !== undefined) {
        const entityId = predecessor.entityId;
        (predecessor as { entityId: string }).entityId = successor.entityId;
        (successor as { entityId: string }).entityId = entityId;
      }
    }
    expect(() =>
      assertBangumiAcceptedEpisodeSet(reversedSequel, multiSeasonOracle),
    ).toThrow(/sequel/u);

    const wrongMembership = multiSeasonInspection();
    const membership =
      wrongMembership.itemResults?.[0]?.accepted?.relationships?.find(
        (relationship) => relationship.type === "asset.membership",
      );
    if (membership !== undefined) {
      const participant = membership.participants.find(
        (item) => item.role === "bangumi.subject.ordinary-episode",
      );
      if (participant !== undefined)
        (participant as { entityId: string }).entityId = "subject-200";
    }
    expect(() =>
      assertBangumiAcceptedEpisodeSet(wrongMembership, multiSeasonOracle),
    ).toThrow();
  });

  it("binds every episode by exact address instead of response order", () => {
    expect(() =>
      assertBangumiAcceptedEpisodeSet(inspection(["1002", "1001"]), oracle),
    ).not.toThrow();

    expect(() =>
      assertBangumiAcceptedEpisodeSet(inspection(["1001", "1001"]), oracle),
    ).toThrow(/exact Bangumi episode address/u);
  });

  it("requires both scoped episode positions and one observed episode artifact", () => {
    const wrongPosition = structuredClone(inspection(["1001", "1002"]));
    const first = wrongPosition.itemResults?.[0]?.accepted;
    const continuous = first?.metadata.find(
      (item) => item.property === "bangumi.episode.continuous-position",
    );
    if (continuous !== undefined) (continuous as { value: string }).value = "2";

    expect(() =>
      assertBangumiAcceptedEpisodeSet(wrongPosition, oracle),
    ).toThrow(/continuous position/u);

    const extraObservedArtifact = structuredClone(inspection(["1001", "1002"]));
    const accepted = extraObservedArtifact.itemResults?.[0]?.accepted;
    if (accepted !== undefined) {
      (accepted.artifacts as { id: string }[]).push({ id: "poster" });
      (
        accepted.locations as {
          id: string;
          artifactId: string;
          address: string;
          kind: "observed";
        }[]
      ).push({
        id: "poster-location",
        artifactId: "poster",
        address: "/observed/poster.jpg",
        kind: "observed",
      });
    }
    expect(() =>
      assertBangumiAcceptedEpisodeSet(extraObservedArtifact, oracle),
    ).toThrow(/one observed episode artifact/u);

    const missingRelationshipOrder = structuredClone(
      inspection(["1001", "1002"]),
    );
    const membership =
      missingRelationshipOrder.itemResults?.[0]?.accepted?.relationships?.find(
        (relationship) => relationship.type === "asset.membership",
      );
    if (membership !== undefined)
      (
        membership as unknown as {
          qualifiers: { key: string; value: string }[];
        }
      ).qualifiers = [{ key: "bangumi.episode.season-position", value: "1" }];
    expect(() =>
      assertBangumiAcceptedEpisodeSet(missingRelationshipOrder, oracle),
    ).toThrow(/relationship ordering qualifiers/u);

    const changedRelationshipOrder = structuredClone(
      inspection(["1001", "1002"]),
    );
    const changedMembership =
      changedRelationshipOrder.itemResults?.[0]?.accepted?.relationships?.find(
        (relationship) => relationship.type === "asset.membership",
      );
    const continuousQualifier = changedMembership?.qualifiers?.find(
      (qualifier) => qualifier.key === "bangumi.episode.continuous-position",
    );
    if (continuousQualifier !== undefined)
      (continuousQualifier as { value: string }).value = "2";
    expect(() =>
      assertBangumiAcceptedEpisodeSet(changedRelationshipOrder, oracle),
    ).toThrow(/relationship ordering qualifiers/u);
  });

  it("compares stable identities by exact address after SQLite reopen", () => {
    const initial = inspection(["1002", "1001"]);
    const reopened = structuredClone(inspection(["1001", "1002"]));
    (reopened.execution as { outcome: string }).outcome = "no-change";
    (reopened as unknown as { sourceRecords: unknown[] }).sourceRecords = [];
    for (const item of reopened.itemResults ?? [])
      (item as { outcome: string }).outcome = "no-change";

    expect(() =>
      assertBangumiReopenedEpisodeSet(initial, reopened, oracle),
    ).not.toThrow();

    const drifted = structuredClone(reopened);
    const accepted = drifted.itemResults?.[0]?.accepted;
    if (accepted !== undefined)
      (accepted.entity as { id: string }).id = "rebuilt-episode";
    expect(() =>
      assertBangumiReopenedEpisodeSet(initial, drifted, oracle),
    ).toThrow(/stable identity/u);
  });

  it("fails without a Digital-owned connection and copies only a dummy connection at mode 0600", async () => {
    const packageRoot = path.resolve(import.meta.dirname, "../..");
    vi.stubEnv("DIGITAL_BANGUMI_LIVE_PRODUCT_DATA", "");
    await expect(
      journey.setup({
        mode: "source",
        packageRoot,
        workDir: "/unused",
        productDataDirectory: "/unused/product-data",
        environmentName: "t11-fixture-context",
        commandEnvironment: {},
      }),
    ).rejects.toThrow(/authorized Bangumi connection/u);

    const temporary = await mkdtemp(
      path.join(tmpdir(), "digital-bangumi-journey-contract-"),
    );
    temporaryDirectories.push(temporary);
    const productData = path.join(temporary, "digital-product-data");
    const connectionDirectory = path.join(
      productData,
      "private-source-connections",
    );
    await mkdir(connectionDirectory, { recursive: true });
    const connection = path.join(connectionDirectory, "bangumi-oauth.json");
    await writeFile(connection, "dummy-private-contract-value", {
      mode: 0o600,
    });
    await chmod(connection, 0o600);
    const workDir = path.join(temporary, "runner-work");
    vi.stubEnv("DIGITAL_BANGUMI_LIVE_PRODUCT_DATA", productData);
    const context = {
      mode: "source" as const,
      packageRoot,
      workDir,
      productDataDirectory: path.join(workDir, "product-data"),
      environmentName: "t11-fixture-context",
      commandEnvironment: {},
    };
    await journey.setup(context);

    for (const name of ["bloom", "frieren"]) {
      const copied = path.join(
        workDir,
        name,
        "private-source-connections",
        "bangumi-oauth.json",
      );
      expect((await stat(copied)).mode & 0o777).toBe(0o600);
    }
    const commands = journey.commands(context);
    expect(commands.map((command) => command.name)).toEqual([
      "register live Bloom root",
      "register live Frieren root",
      "live accept Bloom",
      "live no-change Bloom after SQLite reopen",
      "live metadata refresh Bloom episode",
      "live accept Frieren",
      "live no-change Frieren after SQLite reopen",
    ]);
    expect(
      commands.every(
        (command) =>
          command.env !== undefined &&
          Object.keys(command.env).every(
            (name) => name === "DIGITAL_PRODUCT_DATA",
          ),
      ),
    ).toBe(true);
  });
});
