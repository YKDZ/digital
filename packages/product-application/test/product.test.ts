import {
  workflowCompatibilityCanReuse,
  type EffectiveSubjectRead,
} from "@digital/application";
import { expect, it, vi } from "vitest";

import {
  artifactDownloadOperations,
  productAutomationInformationPlanner,
  curatedInitialRecognitionPolicy,
} from "../src/index.ts";

it("产品自动刷新为 DLsite 主体选择有限资料和封面需求", () => {
  const accepted: EffectiveSubjectRead = {
    id: "asset-dlsite",
    sourceAssociations: [
      {
        sourceIdentity: "dlsite",
        nativeAddress: "https://www.dlsite.com/work/RJ01668691",
      },
    ],
    descriptions: [],
    relatedEntities: [],
    relationships: [],
    locations: [],
  };

  expect(productAutomationInformationPlanner.coordinate).toBe(
    "information-planner:asset-view/1",
  );
  expect(
    productAutomationInformationPlanner.requirementForAcceptedSubject(accepted),
  ).toEqual({
    metadataUsageContext: "asset.ordinary",
    metadata: [
      { property: "asset.title", necessity: "required" },
      { property: "asset.release-date", necessity: "optional" },
      { property: "asset.introduction", necessity: "optional" },
      { property: "asset.declared-language", necessity: "optional" },
      { property: "asset.content-classification", necessity: "optional" },
      { property: "dlsite.product.price-jpy", necessity: "optional" },
      { property: "dlsite.product.genre", necessity: "optional" },
    ],
    artifactRoles: [
      {
        role: "asset.primary-cover",
        necessity: "optional",
        maximum: 1,
      },
    ],
    relationshipTypes: [
      { type: "asset.contribution", necessity: "optional" },
      { type: "asset.membership", necessity: "optional" },
    ],
  });
});

it("产品自动刷新按既有主体类别选择有限资料范围", () => {
  const subject = (
    sourceIdentity: string | undefined,
    descriptions: EffectiveSubjectRead["descriptions"] = [],
  ): EffectiveSubjectRead => ({
    id: "asset-fixture",
    sourceAssociations:
      sourceIdentity === undefined
        ? []
        : [
            {
              sourceIdentity,
              nativeAddress: `${sourceIdentity}:fixture`,
            },
          ],
    descriptions,
    relatedEntities: [],
    relationships: [],
    locations: [],
  });
  const bookFacts: EffectiveSubjectRead["descriptions"][number] = {
    target: { kind: "entity", entityId: "asset-fixture" },
    metadataUsageContext: "asset.ordinary",
    metadataScope: { kind: "all-available" },
    metadata: [
      {
        property: "book.publisher",
        result: {
          status: "resolved",
          values: [
            {
              property: "book.publisher",
              value: "Fixture Publisher",
              qualifiers: [],
              sourceIdentity: "fixture",
              sourceSlot: "fixture:book-publisher",
              reasoning: { kind: "unranked-source-assertion" },
              assertions: [
                {
                  target: { kind: "entity", entityId: "asset-fixture" },
                  sourceSlot: "fixture:book-publisher",
                  sourceRecordIds: ["record-fixture"],
                },
              ],
              sourceRecordIds: ["record-fixture"],
            },
          ],
        },
      },
    ],
    artifactRoles: [],
    missingArtifactRoles: [],
    conflicts: [],
  };
  const unrelatedBookFacts: EffectiveSubjectRead["descriptions"][number] = {
    ...bookFacts,
    target: { kind: "entity", entityId: "related-book" },
  };
  const cases = [
    {
      subject: subject(undefined, [unrelatedBookFacts]),
      metadata: [
        "asset.title",
        "asset.introduction",
        "asset.summary",
        "asset.body",
        "asset.release-date",
        "asset.publication-datetime",
        "asset.declared-language",
        "asset.content-classification",
      ],
      requiredMetadata: [],
      artifacts: ["asset.primary-cover", "asset.material-image"],
      relationships: ["asset.*", "bangumi.subject.related"],
    },
    {
      subject: subject("fanbox"),
      metadata: [
        "asset.title",
        "asset.introduction",
        "asset.summary",
        "asset.body",
        "asset.release-date",
        "asset.publication-datetime",
        "asset.declared-language",
        "asset.content-classification",
      ],
      requiredMetadata: [],
      artifacts: ["asset.primary-cover", "asset.material-image"],
      relationships: ["asset.*", "bangumi.subject.related"],
    },
    {
      subject: subject("bangumi"),
      metadata: [
        "asset.title",
        "asset.introduction",
        "asset.summary",
        "asset.body",
        "asset.release-date",
        "asset.publication-datetime",
        "asset.declared-language",
        "asset.content-classification",
      ],
      requiredMetadata: [],
      artifacts: ["asset.primary-cover", "asset.material-image"],
      relationships: ["asset.*", "bangumi.subject.related"],
    },
    {
      subject: subject("tmdb"),
      metadata: [
        "asset.title",
        "asset.introduction",
        "asset.release-date",
        "asset.runtime-minutes",
        "asset.genre",
        "asset.awards",
        "asset.box-office",
        "rating.*",
      ],
      requiredMetadata: ["asset.title"],
      artifacts: ["asset.primary-cover"],
      relationships: ["asset.contribution"],
    },
    {
      subject: subject(undefined, [bookFacts]),
      metadata: [
        "asset.title",
        "book.isbn-13",
        "book.publisher",
        "book.publication-date",
        "asset.declared-language",
        "asset.summary",
      ],
      requiredMetadata: ["asset.title"],
      artifacts: ["asset.primary-cover", "asset.material-image"],
      relationships: ["asset.contribution"],
    },
  ];

  for (const example of cases) {
    const requirement =
      productAutomationInformationPlanner.requirementForAcceptedSubject(
        example.subject,
      );
    expect(requirement.metadata.map(({ property }) => property)).toEqual(
      example.metadata,
    );
    expect(
      requirement.metadata
        .filter(({ necessity }) => necessity === "required")
        .map(({ property }) => property),
    ).toEqual(example.requiredMetadata);
    expect(
      requirement.artifactRoles.map(({ role, necessity, maximum }) => [
        role,
        necessity,
        maximum,
      ]),
    ).toEqual(example.artifacts.map((role) => [role, "optional", undefined]));
    expect(requirement.artifactRoles.map(({ role }) => role)).toEqual(
      example.artifacts,
    );
    expect(
      requirement.relationshipTypes.every(
        ({ necessity }) => necessity === "optional",
      ),
    ).toBe(true);
    expect(requirement.relationshipTypes.map(({ type }) => type)).toEqual(
      example.relationships,
    );
  }
});

it("产品只信任精确 EPUB 本地出版物规则坐标", () => {
  const policy = curatedInitialRecognitionPolicy();
  const result = {
    capabilityId: "epub.local-publication-recognizer",
    capabilityVersion: "4",
    ruleId: "epub.valid-single-publication-revision",
    ruleVersion: "4",
    outcome: "satisfied" as const,
    explanation: "synthetic EPUB",
    evidence: [],
  };

  expect(policy.trustedRuleCoordinates).toContain(
    "epub.local-publication-recognizer@4/epub.valid-single-publication-revision@4",
  );
  expect(policy.accepts(result)).toBe(true);
  expect(policy.accepts({ ...result, capabilityVersion: "3" })).toBe(false);
  expect(policy.accepts({ ...result, ruleVersion: "3" })).toBe(false);
  expect(policy.accepts({ ...result, ruleVersion: "1" })).toBe(false);
  expect(policy.accepts({ ...result, ruleVersion: "2" })).toBe(false);
  expect(policy.accepts({ ...result, capabilityVersion: "2" })).toBe(false);
  expect(
    policy.accepts({
      ...result,
      capabilityId: "pdf.local-publication-recognizer",
    }),
  ).toBe(false);
  expect(
    policy.accepts({ ...result, ruleId: "epub.valid-publication-revision" }),
  ).toBe(false);
  const nbinet = {
    ...result,
    capabilityId: "nbinet.exact-isbn-recognizer",
    capabilityVersion: "4",
    ruleId: "embedded-isbn-in-exact-official-record",
    ruleVersion: "4",
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
  expect(policy.accepts({ ...nbinet, capabilityVersion: "3" })).toBe(false);
});

it("产品显式采用 PDF v3 规则坐标且不继承 v2/v1 信任", () => {
  const policy = curatedInitialRecognitionPolicy();
  const result = {
    capabilityId: "pdf.local-publication-recognizer",
    capabilityVersion: "3",
    ruleId: "pdf.valid-single-publication-revision",
    ruleVersion: "3",
    outcome: "satisfied" as const,
    explanation: "synthetic PDF",
    evidence: [],
  };

  expect(policy.trustedRuleCoordinates).toContain(
    "pdf.local-publication-recognizer@3/pdf.valid-single-publication-revision@3",
  );
  expect(policy.version).toBe("curated-initial-sources/9");
  expect(policy.accepts(result)).toBe(true);
  expect(policy.accepts({ ...result, ruleVersion: "1" })).toBe(false);
  expect(policy.accepts({ ...result, ruleVersion: "2" })).toBe(false);
  expect(policy.accepts({ ...result, capabilityVersion: "1" })).toBe(false);
  expect(policy.accepts({ ...result, capabilityVersion: "2" })).toBe(false);
  expect(
    policy.accepts({
      ...result,
      capabilityId: "epub.local-publication-recognizer",
    }),
  ).toBe(false);
  expect(
    policy.accepts({ ...result, ruleId: "pdf.valid-publication-revision" }),
  ).toBe(false);
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

it("产品只信任读取新出版物检查坐标的书籍目录规则", () => {
  const policy = curatedInitialRecognitionPolicy();
  const result = {
    capabilityId: "book.local-directory-recognizer",
    capabilityVersion: "2",
    ruleId: "book.same-name-directory-with-valid-publication",
    ruleVersion: "2",
    outcome: "satisfied" as const,
    explanation: "same-name directory contains a valid EPUB inspection",
    evidence: [],
  };

  expect(policy.trustedRuleCoordinates).toContain(
    "book.local-directory-recognizer@2/book.same-name-directory-with-valid-publication@2",
  );
  expect(policy.accepts(result)).toBe(true);
  expect(policy.accepts({ ...result, capabilityVersion: "1" })).toBe(false);
  expect(policy.accepts({ ...result, ruleVersion: "1" })).toBe(false);
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
