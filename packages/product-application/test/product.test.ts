import { expect, it, vi } from "vitest";

import {
  artifactDownloadOperations,
  curatedInitialRecognitionPolicy,
} from "../src/index.ts";

it("产品只信任精确 EPUB 本地出版物规则坐标", () => {
  const policy = curatedInitialRecognitionPolicy();
  const result = {
    capabilityId: "epub.local-publication-recognizer",
    capabilityVersion: "1",
    ruleId: "epub.valid-single-publication-revision",
    ruleVersion: "1",
    outcome: "satisfied" as const,
    explanation: "synthetic EPUB",
    evidence: [],
  };

  expect(policy.trustedRuleCoordinates).toContain(
    "epub.local-publication-recognizer@1/epub.valid-single-publication-revision@1",
  );
  expect(policy.accepts(result)).toBe(true);
  expect(policy.accepts({ ...result, ruleVersion: "2" })).toBe(false);
});

it("ProductApplication 以固定 planPlayback 入口委托同一个精确字节深模块", async () => {
  const planPlayback = vi.fn(async () => ({
    status: "incompatible" as const,
    reason: "format-unknown" as const,
  }));
  const bytes = {
    async describe() {
      throw new Error("not reached");
    },
    async open() {
      throw new Error("not reached");
    },
    planPlayback,
  };
  const confirmation = {
    async observedFileSelectionForLocation() {
      return undefined;
    },
    async readObservedFileConfirmationFacts() {
      return undefined;
    },
    async confirmObservedFileSelection() {
      throw new Error("not reached");
    },
  };
  const operations = artifactDownloadOperations(bytes, confirmation);
  const consumer = {
    contractVersion: "consumer-playback/1" as const,
    supportsByteRanges: true,
    media: [],
  };
  await expect(
    operations.planPlayback(
      { artifactRevisionId: "artifact-revision_product" },
      consumer,
      {},
    ),
  ).resolves.toEqual({ status: "incompatible", reason: "format-unknown" });
  expect(planPlayback).toHaveBeenCalledWith(
    { artifactRevisionId: "artifact-revision_product" },
    consumer,
    {},
  );
});
