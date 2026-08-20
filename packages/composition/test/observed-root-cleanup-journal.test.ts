import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  InProcessObservedRootCleanupEmergencyJournal,
  composeAssetRefresh,
  observedRootCleanupEmergencyJournalCapacity,
} from "../src/index.ts";
import {
  disposePreparedCatalogueTemplate,
  prepareCatalogueAt,
} from "./prepared-catalogue.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await disposePreparedCatalogueTemplate();
});

describe("production observed-root cleanup reporting", () => {
  it("retains a cleanup reporting incident when the stderr reporter fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-cleanup-journal-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const workflow = composeAssetRefresh(productDataDirectory, {});
    const reporterFailure = new Error(
      "private-token /private/observed/path must not enter the journal",
    );
    let stderrWrites = 0;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      stderrWrites += 1;
      throw reporterFailure;
    });

    try {
      await workflow.observedRootRegistrations.reportCleanupFailure({
        operation: "observed-root-execution",
        cleanup: "close-bound-scope",
        rootId: "observed-root-opaque-id",
        relativeScope: "season-1",
        error: new Error("/private/observed/path"),
      });
      expect(stderrWrites).toBe(1);
      const stderrPayload = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(stderrPayload).not.toContain("private-token");
      expect(stderrPayload).not.toContain("/private/observed/path");
      expect(workflow.observedRootCleanupEmergencyJournal.snapshot()).toEqual({
        incidents: [
          {
            event: "observed-root-cleanup-reporting-failure",
            operation: "observed-root-execution",
            cleanup: "close-bound-scope",
            rootId: "observed-root-opaque-id",
            relativeScope: "season-1",
            cleanupErrorKind: "error",
            reporterErrorKind: "error",
          },
        ],
        discardedIncidentCount: 0,
      });
      expect(
        JSON.stringify(workflow.observedRootCleanupEmergencyJournal.snapshot()),
      ).not.toContain("private-token");
      expect(
        JSON.stringify(workflow.observedRootCleanupEmergencyJournal.snapshot()),
      ).not.toContain("/private/observed/path");
    } finally {
      stderr.mockRestore();
      await workflow.close();
    }
  });

  it("keeps the newest bounded incidents and exposes a non-durable drain", () => {
    const journal = new InProcessObservedRootCleanupEmergencyJournal();

    for (
      let index = 0;
      index < observedRootCleanupEmergencyJournalCapacity + 2;
      index += 1
    ) {
      expect(() =>
        journal.reportCleanupReportingFailure({
          cleanupFailure: {
            operation: "observed-root-execution",
            cleanup: "close-bound-scope",
            rootId: `root-${index}`,
            relativeScope: `scope-${index}`,
            error: new Error(`private-token-${index}`),
          },
          reporterError: new Error(`private-token-${index}`),
        }),
      ).not.toThrow();
    }

    const snapshot = journal.snapshot();
    expect(snapshot.incidents).toHaveLength(
      observedRootCleanupEmergencyJournalCapacity,
    );
    expect(snapshot.incidents[0]).toMatchObject({ rootId: "root-2" });
    expect(snapshot.incidents.at(-1)).toMatchObject({
      rootId: `root-${observedRootCleanupEmergencyJournalCapacity + 1}`,
    });
    expect(snapshot.discardedIncidentCount).toBe(2);
    expect(JSON.stringify(snapshot)).not.toContain("private-token");

    expect(journal.drain()).toEqual(snapshot);
    expect(journal.snapshot()).toEqual({
      incidents: [],
      discardedIncidentCount: 0,
    });
  });
});
