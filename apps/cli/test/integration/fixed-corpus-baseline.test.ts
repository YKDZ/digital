import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertContentDigestMatchesBaseline,
  assertInventoryMatchesBaseline,
  fixedCorpusContentDigest,
  fixedCorpusDedicatedIntegrationOwnershipGroups,
  fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle,
  fixedCorpusHistoricallyReviewedRoots,
  fixedCorpusInventory,
  fixedCorpusRoots,
  unsupportedFixedCorpusRoots,
} from "../e2e/fixed-corpus.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("fixed corpus inventory baseline", () => {
  it("routes owned roots to their dedicated integration journeys and statuses", async () => {
    const context = {
      mode: "source",
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      workDir: "/unused",
    } as const;
    const [allRoots, ownershipGroups, historicallyReviewedRoots, safetyRoots] =
      await Promise.all([
        fixedCorpusRoots(context),
        fixedCorpusDedicatedIntegrationOwnershipGroups(context),
        fixedCorpusHistoricallyReviewedRoots(context),
        unsupportedFixedCorpusRoots(context),
      ]);

    expect(allRoots).toHaveLength(29);
    expect(
      ownershipGroups.map((group) => ({
        ownerTicket: group.ownerTicket,
        journey: group.journey,
        status: group.status,
        rootCount: group.roots.length,
      })),
    ).toEqual([
      {
        ownerTicket: "v1-live-acceptance/issues/01-dlsite-eight-live-gate.md",
        journey: "dlsite-eight-live",
        status: "implemented",
        rootCount: 8,
      },
      {
        ownerTicket: "v1-live-acceptance/issues/02-fanbox-five-live-gate.md",
        journey: "fanbox-five-live",
        status: "external-gated",
        rootCount: 5,
      },
      {
        ownerTicket:
          "v1-live-acceptance/issues/03-epub-publication-live-gate.md",
        journey: "epub-publication-live",
        status: "implemented",
        rootCount: 6,
      },
      {
        ownerTicket: "v1-live-acceptance/issues/04-pdf-series-live-gate.md",
        journey: "pdf-publication-live",
        status: "implemented",
        rootCount: 1,
      },
      {
        ownerTicket:
          "v1-live-acceptance/issues/05-bangumi-episodic-live-gate.md",
        journey: "bangumi-episodic-live",
        status: "implemented",
        rootCount: 2,
      },
      {
        ownerTicket: "v1-live-acceptance/issues/06-film-tmdb-omdb-live-gate.md",
        journey: "tmdb-omdb-live",
        status: "implemented",
        rootCount: 2,
      },
    ]);
    const ownedRoots = ownershipGroups.flatMap((group) => group.roots);
    expect(ownedRoots).toHaveLength(24);
    expect(new Set(ownedRoots.map((root) => root.logicalRoot)).size).toBe(24);
    expect(historicallyReviewedRoots).toHaveLength(15);
    expect(
      historicallyReviewedRoots.some((root) =>
        root.logicalRoot.startsWith("appdata/booklore/books/"),
      ),
    ).toBe(false);
    expect(safetyRoots).toHaveLength(5);
    expect(safetyRoots.map((root) => root.logicalRoot)).toEqual([
      "media/music/25時、ナイトコードで。 — 25時、ナイトコードで。 SEKAI ALBUM vol.3 (2025) {BRMM-10894} [CD-FLAC]",
      "media/music/[EAC][110612][ボーマス16][同人][Baguettes Ensemble][The Vocaloid Jazz sessions Vol.3][FLAC+CUE+LOG]",
      "media/music/『プロジェクトセカイ カラフルステージ! feat. 初音ミク』25時、ナイトコードで。 8th Single「演劇／25時の情熱」[FLAC]",
      "media/pics/プロジェクトセカイ カラフルステージ！ feat. 初音ミク 公式ビジュアルファンブック Vol.3[332P][JPG]",
      "media/Boku no Risou no Isekai Seikatsu - 04",
    ]);
  });

  it("rejects inventory drift instead of accepting a freshly observed tree as expected", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "digital-baseline-"));
    cleanup.push(directory);
    await writeFile(path.join(directory, "ordinary.txt"), "ordinary");
    const actual = await fixedCorpusInventory({
      logicalRoot: "sample",
      directory,
    });

    expect(() =>
      assertInventoryMatchesBaseline(actual, {
        ...actual,
        fileCount: actual.fileCount + 1,
      }),
    ).toThrow("fixed corpus inventory baseline drifted: sample");
  });

  it("rejects duplicate owned roots instead of silently changing the unresolved complement", async () => {
    const context = {
      mode: "source",
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      workDir: "/unused",
    } as const;
    const [roots, rawOracle] = await Promise.all([
      fixedCorpusRoots(context),
      readFile(
        path.resolve(
          context.packageRoot,
          "../..",
          ".scratch/acceptance-corpus/references/reviewed-oracle.json",
        ),
        "utf8",
      ),
    ]);
    const oracle = JSON.parse(rawOracle) as {
      reviewedSupportedRoots: string[];
      dedicatedIntegrationOwnershipGroups: {
        roots: string[];
      }[];
    };
    oracle.reviewedSupportedRoots = ["not-an-owned-root"];
    oracle.dedicatedIntegrationOwnershipGroups[1]!.roots[0] =
      oracle.dedicatedIntegrationOwnershipGroups[0]!.roots[0]!;

    expect(() =>
      fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle(oracle, roots),
    ).toThrow("fixed corpus routing has a duplicate owned root");
  });

  it("rejects unknown roots and incomplete ownership-group contracts", async () => {
    const context = {
      mode: "source",
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      workDir: "/unused",
    } as const;
    const [roots, rawOracle] = await Promise.all([
      fixedCorpusRoots(context),
      readFile(
        path.resolve(
          context.packageRoot,
          "../..",
          ".scratch/acceptance-corpus/references/reviewed-oracle.json",
        ),
        "utf8",
      ),
    ]);
    type OwnershipGroup = {
      ownerTicket?: string;
      journey?: string;
      status?: string;
      roots?: string[];
    };
    type Oracle = {
      dedicatedIntegrationOwnershipGroups: OwnershipGroup[];
    };
    const original = JSON.parse(rawOracle) as Oracle;
    const cases: readonly {
      readonly expected: string;
      readonly mutate: (oracle: Oracle) => void;
    }[] = [
      {
        expected: "contains an unknown root",
        mutate: (oracle) => {
          oracle.dedicatedIntegrationOwnershipGroups[0]!.roots![0] =
            "not-an-owned-root";
        },
      },
      {
        expected: "ownership group count drifted",
        mutate: (oracle) => {
          oracle.dedicatedIntegrationOwnershipGroups.pop();
        },
      },
      {
        expected: "ownerTicket must be a non-empty string",
        mutate: (oracle) => {
          delete oracle.dedicatedIntegrationOwnershipGroups[0]!.ownerTicket;
        },
      },
      {
        expected: "has an unknown status",
        mutate: (oracle) => {
          oracle.dedicatedIntegrationOwnershipGroups[0]!.status = "completed";
        },
      },
      {
        expected: "status must be implemented",
        mutate: (oracle) => {
          oracle.dedicatedIntegrationOwnershipGroups[0]!.status = "pending";
        },
      },
      {
        expected: "journey must be a non-empty string",
        mutate: (oracle) => {
          delete oracle.dedicatedIntegrationOwnershipGroups[3]!.journey;
        },
      },
    ];

    for (const testCase of cases) {
      const oracle = structuredClone(original);
      testCase.mutate(oracle);
      expect(() =>
        fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle(oracle, roots),
      ).toThrow(testCase.expected);
    }
  });

  it("rejects same-path same-size content drift against the approved digest", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digital-content-baseline-"),
    );
    cleanup.push(directory);
    const file = path.join(directory, "ordinary.bin");
    await writeFile(file, "AAAA");
    const approved = await fixedCorpusContentDigest({
      logicalRoot: "sample",
      directory,
    });

    await writeFile(file, "BBBB");
    const changed = await fixedCorpusContentDigest({
      logicalRoot: "sample",
      directory,
    });

    expect(changed.contentDigest).not.toBe(approved.contentDigest);
    expect(() => assertContentDigestMatchesBaseline(changed, approved)).toThrow(
      "fixed corpus content baseline drifted: sample",
    );
  });
});
