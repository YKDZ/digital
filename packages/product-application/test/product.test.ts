import { workflowCompatibilityCanReuse } from "@digital/application";
import { expect, it, vi } from "vitest";

import {
  artifactDownloadOperations,
  curatedInitialRecognitionPolicy,
} from "../src/index.ts";

it("产品只信任精确 EPUB 本地出版物规则坐标", () => {
  const policy = curatedInitialRecognitionPolicy();
  const result = {
    capabilityId: "epub.local-publication-recognizer",
    capabilityVersion: "2",
    ruleId: "epub.valid-single-publication-revision",
    ruleVersion: "2",
    outcome: "satisfied" as const,
    explanation: "synthetic EPUB",
    evidence: [],
  };

  expect(policy.trustedRuleCoordinates).toContain(
    "epub.local-publication-recognizer@2/epub.valid-single-publication-revision@2",
  );
  expect(policy.accepts(result)).toBe(true);
  expect(policy.accepts({ ...result, ruleVersion: "1" })).toBe(false);
  expect(policy.accepts({ ...result, capabilityVersion: "1" })).toBe(false);
  const nbinet = {
    ...result,
    capabilityId: "nbinet.exact-isbn-recognizer",
    ruleId: "embedded-isbn-in-exact-official-record",
  };
  expect(policy.accepts(nbinet)).toBe(true);
  expect(
    policy.accepts({
      ...nbinet,
      ruleId: "directed-isbn-in-exact-official-record",
      ruleVersion: "1",
    }),
  ).toBe(true);
  expect(policy.accepts({ ...nbinet, capabilityVersion: "1" })).toBe(false);
});

it("产品显式采用 PDF v2 规则坐标且不继承 v1 信任", () => {
  const policy = curatedInitialRecognitionPolicy();
  const result = {
    capabilityId: "pdf.local-publication-recognizer",
    capabilityVersion: "2",
    ruleId: "pdf.valid-single-publication-revision",
    ruleVersion: "2",
    outcome: "satisfied" as const,
    explanation: "synthetic PDF",
    evidence: [],
  };

  expect(policy.trustedRuleCoordinates).toContain(
    "pdf.local-publication-recognizer@2/pdf.valid-single-publication-revision@2",
  );
  expect(policy.version).toBe("curated-initial-sources/7");
  expect(policy.accepts(result)).toBe(true);
  expect(policy.accepts({ ...result, ruleVersion: "1" })).toBe(false);
  expect(policy.accepts({ ...result, capabilityVersion: "1" })).toBe(false);
  expect(
    workflowCompatibilityCanReuse(
      {
        workflowVersion: "asset-refresh/2",
        policyVersion: "curated-initial-sources/4",
        capabilityCoordinates: ["pdf.local-publication-recognizer@1/1/1"],
      },
      {
        workflowVersion: "asset-refresh/2",
        policyVersion: policy.version,
        capabilityCoordinates: ["pdf.local-publication-recognizer@1/1/1"],
      },
    ),
  ).toBe(false);
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
