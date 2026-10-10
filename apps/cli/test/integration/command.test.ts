import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
import { inspectProductionCatalogueReadiness } from "@digital/db-migrations";
import { describe, expect, it } from "vitest";

import {
  runCli,
  type CliProductApplication,
  type CliRuntime,
} from "../../src/main.ts";
import { prepareCliProductData } from "../prepare-catalogue.ts";

function legacyCliApplication(input: unknown): CliProductApplication {
  const legacy = input as {
    readonly openAssetRefresh: () => unknown;
    readonly openAutomationHost: () => unknown;
    readonly createOfflineBackup?: (backupDirectory: string) => Promise<void>;
  };
  let workflow: unknown;
  let automation: unknown;
  return {
    get workflow() {
      return (workflow ??= legacy.openAssetRefresh()) as never;
    },
    get automation() {
      return (automation ??= legacy.openAutomationHost()) as never;
    },
    async startAutomation() {
      await (
        (automation ??= legacy.openAutomationHost()) as {
          readonly start?: () => Promise<void>;
        }
      ).start?.();
    },
    async createOfflineBackup(backupDirectory) {
      await legacy.createOfflineBackup?.(backupDirectory);
    },
  };
}

let commandName = "demo-cli";
commandName = "cli";

function testRuntime(
  args: readonly string[],
  version = "1.2.3",
): {
  readonly runtime: CliRuntime;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    runtime: {
      argv: ["node", commandName, ...args],
      streams: {
        stdin: {},
        stdout: { write: (chunk) => (stdout += chunk) },
        stderr: { write: (chunk) => (stderr += chunk) },
      },
      cwd: "/workspace",
      env: { MODE: "test" },
      tty: { stdin: false, stdout: false, stderr: false },
      version,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("CLI command control", () => {
  it("prepares disposable product data through the reviewed production migrations", async () => {
    const productData = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-cli-prepare-"),
    );
    try {
      await prepareCliProductData(productData);

      await expect(
        inspectProductionCatalogueReadiness({
          productDataDirectory: productData,
        }),
      ).resolves.toMatchObject({ state: "ready" });
    } finally {
      await rm(productData, { recursive: true, force: true });
    }
  });

  it("parses greet and writes business output to the injected stream", async () => {
    const output = testRuntime(["greet", "  Ada Lovelace  "]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toBe("Hello, Ada Lovelace\n");
    expect(output.stderr()).toBe("");
  });

  it("renders the injected package version", async () => {
    const output = testRuntime(["--version"], "9.8.7");

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toBe("9.8.7\n");
    expect(output.stderr()).toBe("");
  });

  it("renders Commander help without exiting the process", async () => {
    const output = testRuntime(["--help"]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toContain(
      `Usage: ${commandName} [options] [command]`,
    );
    expect(output.stdout()).toContain("greet <name>");
    expect(output.stderr()).toBe("");
  });

  it("keeps directed re-scrape input source-neutral", async () => {
    const output = testRuntime(["rescrape", "--help"]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toContain("<source-identity>");
    expect(output.stdout()).toContain("<source-input-json>");
    expect(output.stdout()).not.toContain("DLsite");
    expect(output.stderr()).toBe("");
  });

  it("reports missing arguments as Commander usage errors", async () => {
    const output = testRuntime(["greet"]);

    await expect(runCli(output.runtime)).resolves.toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain(
      "error: missing required argument 'name'",
    );
    expect(output.stderr()).toContain(`Usage: ${commandName} greet`);
  });

  it("adapts business validation into a testable command error", async () => {
    const output = testRuntime(["greet", "   "]);

    await expect(runCli(output.runtime)).resolves.toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("error: Name must not be empty");
  });

  it("returns a command failure while the executable root retains lifecycle ownership", async () => {
    const productData = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-cli-close-"),
    );
    await prepareCliProductData(productData);
    const output = testRuntime(["inspect", "missing"]);
    const product = runProduct(
      { productDataDirectory: productData, environment: {} },
      { start: (application) => application },
    );
    try {
      await expect(runCli(output.runtime, product.result)).resolves.toBe(1);
      expect(
        output.stderr().match(/error: 未找到刷新记录 missing/gu),
      ).toHaveLength(1);
    } finally {
      await product.close();
      await rm(productData, { recursive: true, force: true });
    }
  });

  it("applies one saved change-impact preview and renders its safe JSON inspection", async () => {
    const output = testRuntime([
      "apply-preview",
      "preview-1",
      "--actor",
      "reviewer",
      "--json",
    ]);
    const calls: string[] = [];
    let closes = 0;
    const application = {
      openAssetRefresh() {
        return {
          async applyChangeImpactPreview(input: {
            readonly previewId: string;
          }) {
            const { previewId } = input;
            calls.push(previewId);
            return { status: "applied" };
          },
          async inspectChangeImpactPreview(previewId: string) {
            return { id: previewId, status: "applied" };
          },
          close() {
            closes += 1;
          },
        };
      },
      openAutomationHost() {
        throw new Error("not used");
      },
    } as unknown as CliProductApplication;

    await expect(
      runCli(output.runtime, legacyCliApplication(application)),
    ).resolves.toBe(0);
    expect(calls).toEqual(["preview-1"]);
    expect(JSON.parse(output.stdout())).toMatchObject({
      format: "temporary-change-impact-preview/v1",
      preview: { id: "preview-1", status: "applied" },
    });
    expect(output.stderr()).toBe("");
    expect(closes).toBe(0);
  });

  it("rejects one saved change-impact preview and renders its safe JSON inspection", async () => {
    const output = testRuntime([
      "reject-preview",
      "preview-2",
      "--actor",
      "reviewer",
      "--json",
    ]);
    const calls: string[] = [];
    let closes = 0;
    const application = {
      openAssetRefresh() {
        return {
          async rejectChangeImpactPreview(input: {
            readonly previewId: string;
          }) {
            const { previewId } = input;
            calls.push(previewId);
            return { id: previewId, status: "rejected" };
          },
          close() {
            closes += 1;
          },
        };
      },
      openAutomationHost() {
        throw new Error("not used");
      },
    } as unknown as CliProductApplication;

    await expect(
      runCli(output.runtime, legacyCliApplication(application)),
    ).resolves.toBe(0);
    expect(calls).toEqual(["preview-2"]);
    expect(JSON.parse(output.stdout())).toMatchObject({
      format: "temporary-change-impact-preview/v1",
      preview: { id: "preview-2", status: "rejected" },
    });
    expect(output.stderr()).toBe("");
    expect(closes).toBe(0);
  });

  it("continues an ambiguous source decision only through its opaque candidate reference", async () => {
    const reference = "a".repeat(64);
    const output = testRuntime([
      "select-source-candidate",
      "execution-ambiguous",
      reference,
      "--json",
    ]);
    const calls: unknown[] = [];
    const application = {
      openAssetRefresh() {
        return {
          async selectSourceAssociationCandidate(input: unknown) {
            calls.push(input);
            return {
              executionId: "execution-ambiguous",
              state: "awaiting-confirmation",
              candidates: [
                {
                  reference,
                  outcome: "accepted",
                  sourceIdentity: "source",
                  nativeAddress: "opaque:work",
                  ruleResults: [],
                  explanation: "候选已选择",
                },
              ],
            };
          },
          close() {},
        };
      },
      openAutomationHost() {
        throw new Error("not used");
      },
    } as unknown as CliProductApplication;

    await expect(
      runCli(output.runtime, legacyCliApplication(application)),
    ).resolves.toBe(0);
    expect(calls).toEqual([
      { executionId: "execution-ambiguous", candidateReference: reference },
    ]);
    expect(output.stdout()).not.toContain("sourceRecordIds");
    expect(output.stderr()).toBe("");
  });

  it("reports a missing change-impact preview without taking root ownership", async () => {
    const output = testRuntime([
      "apply-preview",
      "missing",
      "--actor",
      "reviewer",
      "--json",
    ]);
    let closes = 0;
    const application = {
      openAssetRefresh() {
        return {
          async applyChangeImpactPreview() {
            throw new Error("未找到变更影响预演");
          },
          close() {
            closes += 1;
          },
        };
      },
      openAutomationHost() {
        throw new Error("not used");
      },
    } as unknown as CliProductApplication;

    await expect(
      runCli(output.runtime, legacyCliApplication(application)),
    ).resolves.toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr().match(/error: 未找到变更影响预演/gu)).toHaveLength(
      1,
    );
    expect(closes).toBe(0);
  });

  it("reports a stale applied preview explicitly after rendering its inspection", async () => {
    const output = testRuntime([
      "apply-preview",
      "stale-preview",
      "--actor",
      "reviewer",
      "--json",
    ]);
    const application = {
      openAssetRefresh() {
        return {
          async applyChangeImpactPreview() {
            return { status: "stale" };
          },
          async inspectChangeImpactPreview(previewId: string) {
            return { id: previewId, status: "stale" };
          },
          close() {},
        };
      },
      openAutomationHost() {
        throw new Error("not used");
      },
    } as unknown as CliProductApplication;

    await expect(
      runCli(output.runtime, legacyCliApplication(application)),
    ).resolves.toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({
      preview: { id: "stale-preview", status: "stale" },
    });
    expect(output.stderr().match(/error: 变更影响预演已过期/gu)).toHaveLength(
      1,
    );
  });

  it("reports a missing preview from rejection without taking root ownership", async () => {
    const output = testRuntime([
      "reject-preview",
      "missing",
      "--actor",
      "reviewer",
      "--json",
    ]);
    let closes = 0;
    const application = {
      openAssetRefresh() {
        return {
          async rejectChangeImpactPreview() {
            throw new Error("未找到变更影响预演");
          },
          close() {
            closes += 1;
          },
        };
      },
      openAutomationHost() {
        throw new Error("not used");
      },
    } as unknown as CliProductApplication;

    await expect(
      runCli(output.runtime, legacyCliApplication(application)),
    ).resolves.toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr().match(/error: 未找到变更影响预演/gu)).toHaveLength(
      1,
    );
    expect(closes).toBe(0);
  });

  it("reports a stale rejected preview explicitly after rendering its inspection", async () => {
    const output = testRuntime([
      "reject-preview",
      "stale-preview",
      "--actor",
      "reviewer",
      "--json",
    ]);
    const application = {
      openAssetRefresh() {
        return {
          async rejectChangeImpactPreview(input: {
            readonly previewId: string;
          }) {
            const { previewId } = input;
            return { id: previewId, status: "stale" };
          },
          close() {},
        };
      },
      openAutomationHost() {
        throw new Error("not used");
      },
    } as unknown as CliProductApplication;

    await expect(
      runCli(output.runtime, legacyCliApplication(application)),
    ).resolves.toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({
      preview: { id: "stale-preview", status: "stale" },
    });
    expect(output.stderr().match(/error: 变更影响预演已过期/gu)).toHaveLength(
      1,
    );
  });

  it("returns nonzero after rendering an inspectable partially succeeded metadata refresh", async () => {
    const output = testRuntime(["refresh-metadata", "asset", "--json"]);
    const application = {
      openAssetRefresh() {
        return {
          async refreshMetadata() {
            return {
              execution: {
                id: "partial",
                selection: {
                  intent: "metadata-refresh",
                },
                operationKind: "refresh-metadata",
                requestedSelection: {
                  version: "asset-refresh-selection/1",
                  subjects: [],
                  filesystemScopes: [],
                },
                resolvedSelection: {
                  version: "asset-refresh-selection/1",
                  subjects: [],
                  filesystemScopes: [],
                },
                targetDispositions: [],
                filesystemSnapshots: [],
                status: "completed",
                stage: "completed",
                outcome: "partially-succeeded",
                sourceRecordIds: [],
                reason: "可选来源未完成",
                dispositions: [],
              },
              sourceRecords: [],
            };
          },
          close() {},
        };
      },
      openAutomationHost() {
        throw new Error("not used");
      },
    } as unknown as CliProductApplication;

    await expect(
      runCli(output.runtime, legacyCliApplication(application)),
    ).resolves.toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({
      execution: {
        id: "partial",
        outcome: "partially-succeeded",
        reason: "可选来源未完成",
      },
    });
    expect(output.stderr()).toContain("error: 可选来源未完成");
    expect(output.stderr().match(/error: 可选来源未完成/gu)).toHaveLength(1);
  });

  it("renders every source and the effective metadata audit for each work item", async () => {
    const output = testRuntime(["refresh-metadata", "asset"]);
    const jsonOutput = testRuntime(["refresh-metadata", "asset", "--json"]);
    const entityTarget = { kind: "entity", entityId: "asset" } as const;
    const accepted = {
      entity: { id: "asset", kind: "digital-asset" },
      recognitionSourceAssociation: {
        sourceIdentity: "tmdb",
        nativeAddress: "tmdb:9509",
      },
      sourceAssociations: [
        { sourceIdentity: "tmdb", nativeAddress: "tmdb:9509" },
        { sourceIdentity: "omdb", nativeAddress: "omdb:tt0328107" },
      ],
      // 原始逐项来源断言保留全部候选，包括未被采用的 tmdb 评分候选。
      metadata: [
        {
          target: entityTarget,
          property: "asset.rating",
          sourceSlot: "omdb.rating",
          value: "7.7",
          sourceRecordIds: ["omdb-record"],
        },
        {
          target: entityTarget,
          property: "asset.rating",
          sourceSlot: "tmdb.vote-average",
          value: "7.2",
          sourceRecordIds: ["tmdb-record"],
        },
        {
          target: entityTarget,
          property: "asset.title",
          sourceSlot: "tmdb.title",
          value: "怒火救援",
          sourceRecordIds: ["tmdb-record"],
        },
        {
          target: entityTarget,
          property: "asset.title",
          sourceSlot: "omdb.title",
          value: "怒火救援：完全版",
          sourceRecordIds: ["omdb-record"],
        },
      ],
      entities: [],
      relationships: [
        {
          id: "rel-director",
          type: "credit.directed_by",
          sourceSlot: "tmdb.director",
          participants: [
            { entityId: "asset", role: "subject" },
            { entityId: "person-director", role: "object" },
          ],
          sourceRecordIds: ["tmdb-record"],
        },
      ],
      recognitionExplanation: "已由严格目录规则识别",
      artifacts: [{ id: "cover-artifact" }],
      blobs: [
        {
          digest: "cover-digest",
          mediaType: "image/jpeg",
          byteLength: 4,
        },
      ],
      artifactRevisions: [
        {
          id: "cover-revision",
          artifactId: "cover-artifact",
          blobDigest: "cover-digest",
        },
      ],
      locations: [
        {
          id: "cover-location",
          artifactId: "cover-artifact",
          kind: "managed",
          address: "poster.jpg",
        },
      ],
      artifactAssociations: [
        {
          id: "cover-association",
          target: entityTarget,
          artifactId: "cover-artifact",
          role: "asset.primary-cover",
          sourceRecordIds: ["tmdb-record"],
        },
      ],
      currentRelatedEntities: [
        {
          id: "person-director",
          sourceIdentity: "tmdb",
          sourceKey: "p-1",
          identityNamespace: "tmdb:person",
          label: "导演甲",
          sourceRecordIds: ["tmdb-record"],
          kind: { status: "ordinary" },
        },
      ],
      // 共同生效读取：普通消费路径唯一的事实契约。
      facts: {
        id: "asset",
        recognitionSourceAssociation: {
          sourceIdentity: "tmdb",
          nativeAddress: "tmdb:9509",
        },
        sourceAssociations: [
          { sourceIdentity: "tmdb", nativeAddress: "tmdb:9509" },
          { sourceIdentity: "omdb", nativeAddress: "omdb:tt0328107" },
        ],
        descriptions: [
          {
            target: entityTarget,
            metadataUsageContext: "asset.ordinary",
            metadata: [
              {
                property: "asset.rating",
                result: {
                  status: "resolved",
                  values: [
                    {
                      property: "asset.rating",
                      value: "7.7",
                      sourceIdentity: "omdb",
                      sourceSlot: "omdb.rating",
                      sourceRecordIds: ["omdb-record"],
                      assertions: [
                        {
                          target: entityTarget,
                          sourceSlot: "omdb.rating",
                          sourceRecordIds: ["omdb-record"],
                        },
                      ],
                      reasoning: {
                        kind: "source-preference",
                        preferredSource: "omdb",
                      },
                    },
                  ],
                },
              },
              {
                property: "asset.title",
                result: {
                  status: "conflict",
                  conflict: {
                    kind: "policy-conflict",
                    property: "asset.title",
                    references: [
                      {
                        kind: "metadata",
                        target: entityTarget,
                        sourceSlot: "tmdb.title",
                        sourceRecordIds: ["tmdb-record"],
                      },
                      {
                        kind: "metadata",
                        target: entityTarget,
                        sourceSlot: "omdb.title",
                        sourceRecordIds: ["omdb-record"],
                      },
                    ],
                    explanation: "规则 first、second 尚未确定先后",
                  },
                },
              },
              { property: "asset.runtime", result: { status: "missing" } },
            ],
            metadataScope: { kind: "all-available" },
            artifactRoles: [
              {
                role: "asset.primary-cover",
                artifactId: "cover-artifact",
                associationIds: ["cover-association"],
                locationId: "cover-location",
                address: "poster.jpg",
              },
            ],
            missingArtifactRoles: ["asset.material-image"],
            conflicts: [
              {
                kind: "policy-conflict",
                property: "asset.title",
                references: [
                  {
                    kind: "metadata",
                    target: entityTarget,
                    sourceSlot: "tmdb.title",
                    sourceRecordIds: ["tmdb-record"],
                  },
                  {
                    kind: "metadata",
                    target: entityTarget,
                    sourceSlot: "omdb.title",
                    sourceRecordIds: ["omdb-record"],
                  },
                ],
                explanation: "规则 first、second 尚未确定先后",
              },
            ],
          },
        ],
        relatedEntities: [
          {
            id: "person-director",
            kind: { status: "ordinary" },
            label: "导演甲",
            sourceIdentity: "tmdb",
            identityNamespace: "tmdb:person",
            sourceKey: "p-1",
          },
        ],
        relationships: [
          {
            id: "rel-director",
            type: "credit.directed_by",
            participants: [
              { entityId: "asset", role: "subject" },
              { entityId: "person-director", role: "object" },
            ],
            sourceRecordIds: ["tmdb-record"],
          },
        ],
        locations: [
          {
            id: "cover-location",
            artifactId: "cover-artifact",
            kind: "managed",
            address: "poster.jpg",
            content: {
              status: "confirmed",
              target: {
                kind: "artifact-revision",
                artifactId: "cover-artifact",
                revisionId: "cover-revision",
              },
            },
          },
        ],
      },
    };
    const inspectionResult = {
      execution: {
        id: "itemized",
        selection: { intent: "metadata-refresh" },
        operationKind: "refresh-metadata",
        requestedSelection: {
          version: "asset-refresh-selection/1",
          subjects: [],
          filesystemScopes: [],
        },
        resolvedSelection: {
          version: "asset-refresh-selection/1",
          subjects: [],
          filesystemScopes: [],
        },
        targetDispositions: [],
        filesystemSnapshots: [],
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        sourceRecordIds: ["tmdb-record", "omdb-record"],
        dispositions: [],
      },
      sourceRecords: [],
      accepted,
      itemResults: [
        {
          key: "movie",
          relativePaths: ["怒火救援 (2004)/怒火救援 (2004).mkv"],
          outcome: "accepted",
          recognition: {
            status: "accepted",
            explanation: "已由严格目录规则识别",
          },
          accepted,
        },
      ],
    };
    const application = {
      openAssetRefresh() {
        return {
          async refreshMetadata() {
            return inspectionResult;
          },
          close() {},
        };
      },
      openAutomationHost() {
        throw new Error("not used");
      },
    } as unknown as CliProductApplication;

    await expect(
      runCli(output.runtime, legacyCliApplication(application)),
      output.stderr(),
    ).resolves.toBe(0);
    expect(
      await runCli(jsonOutput.runtime, legacyCliApplication(application)),
      jsonOutput.stderr(),
    ).toBe(0);
    expect(output.stdout()).toContain("\n  tmdb：tmdb:9509");
    expect(output.stdout()).toContain("\n  omdb：omdb:tt0328107");
    expect(output.stdout()).toContain(
      "\n当前采用：\n  asset.rating：7.7（omdb；记录 omdb-record；来源位置 omdb.rating）\n    选择依据：采用首选来源 omdb",
    );
    expect(output.stdout()).toContain(
      "\n元数据规则冲突：\n  asset.title：存在尚未解决的资料选择，当前没有采用值",
    );
    expect(output.stdout()).toContain("  导演甲（entity）");
    expect(output.stdout()).toContain(
      "  credit.directed_by：subject：asset；object：导演甲（记录 tmdb-record）",
    );
    expect(output.stdout()).toContain("识别说明：已由严格目录规则识别");
    expect(output.stdout()).toContain(
      "  asset.primary-cover：poster.jpg（已托管）",
    );
    expect(output.stdout()).toContain("边界 movie：accepted");
    expect(output.stdout()).toContain("\n    tmdb：tmdb:9509");
    expect(output.stdout()).toContain(
      "\n  当前采用：\n    asset.rating：7.7（omdb；记录 omdb-record；来源位置 omdb.rating）\n      选择依据：采用首选来源 omdb",
    );
    expect(output.stdout()).toContain(
      "\n  元数据规则冲突：\n    asset.title：存在尚未解决的资料选择，当前没有采用值",
    );
    expect(output.stdout()).not.toContain("7.2");
    expect(output.stdout()).not.toContain("tmdb.vote-average");
    expect(output.stdout()).not.toContain("first、second");

    const json = JSON.parse(jsonOutput.stdout()) as typeof inspectionResult;
    expect(json.accepted?.entity.id).toBe("asset");
    expect(json.accepted?.facts.id).toBe("asset");
    expect(json.accepted?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.rating",
          value: "7.2",
          sourceSlot: "tmdb.vote-average",
          sourceRecordIds: ["tmdb-record"],
        }),
      ]),
    );
    const [description] = json.accepted?.facts.descriptions ?? [];
    expect(description?.metadata).toEqual([
      expect.objectContaining({
        property: "asset.rating",
        result: expect.objectContaining({
          status: "resolved",
          values: [
            expect.objectContaining({
              value: "7.7",
              sourceIdentity: "omdb",
              sourceSlot: "omdb.rating",
            }),
          ],
        }),
      }),
      expect.objectContaining({
        property: "asset.title",
        result: expect.objectContaining({
          status: "conflict",
          conflict: expect.objectContaining({
            kind: "policy-conflict",
            property: "asset.title",
            explanation: "规则 first、second 尚未确定先后",
          }),
        }),
      }),
      expect.objectContaining({
        property: "asset.runtime",
        result: { status: "missing" },
      }),
    ]);
    expect(description?.artifactRoles).toEqual([
      expect.objectContaining({
        role: "asset.primary-cover",
        artifactId: "cover-artifact",
        associationIds: ["cover-association"],
      }),
    ]);
    expect(description?.missingArtifactRoles).toEqual(["asset.material-image"]);
    expect(json.accepted?.facts.locations).toEqual([
      expect.objectContaining({
        id: "cover-location",
        kind: "managed",
        content: expect.objectContaining({
          status: "confirmed",
          target: expect.objectContaining({ revisionId: "cover-revision" }),
        }),
      }),
    ]);
    expect(
      json.itemResults?.[0]?.accepted?.facts.descriptions[0]?.metadata,
    ).toEqual(description?.metadata);
  });
});
