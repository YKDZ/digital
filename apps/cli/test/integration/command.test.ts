import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
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
    expect(output.stdout()).toContain("--source-identity <identity>");
    expect(output.stdout()).toContain("<source-address>");
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
    const output = testRuntime(["apply-preview", "preview-1", "--json"]);
    const calls: string[] = [];
    let closes = 0;
    const application = {
      openAssetRefresh() {
        return {
          async applyChangeImpactPreview(previewId: string) {
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
    const output = testRuntime(["reject-preview", "preview-2", "--json"]);
    const calls: string[] = [];
    let closes = 0;
    const application = {
      openAssetRefresh() {
        return {
          async rejectChangeImpactPreview(previewId: string) {
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

  it("reports a missing change-impact preview without taking root ownership", async () => {
    const output = testRuntime(["apply-preview", "missing", "--json"]);
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
    const output = testRuntime(["apply-preview", "stale-preview", "--json"]);
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
    const output = testRuntime(["reject-preview", "missing", "--json"]);
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
    const output = testRuntime(["reject-preview", "stale-preview", "--json"]);
    const application = {
      openAssetRefresh() {
        return {
          async rejectChangeImpactPreview(previewId: string) {
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
    const accepted = {
      entity: { id: "asset", kind: "Entity", label: "怒火救援" },
      sourceAssociation: {
        subjectId: "asset",
        sourceIdentity: "tmdb",
        nativeAddress: "tmdb:9509",
        sourceRecordIds: ["tmdb-record"],
      },
      sourceAssociations: [
        {
          subjectId: "asset",
          sourceIdentity: "tmdb",
          nativeAddress: "tmdb:9509",
          sourceRecordIds: ["tmdb-record"],
        },
        {
          subjectId: "asset",
          sourceIdentity: "omdb",
          nativeAddress: "omdb:tt0328107",
          sourceRecordIds: ["omdb-record"],
        },
      ],
      metadata: [],
      effectiveMetadata: [
        {
          property: "asset.rating",
          value: "7.7",
          sourceIdentity: "omdb",
          sourceRecordIds: ["omdb-record"],
          sourceSlot: "omdb.rating",
          reasoning: {
            kind: "source-preference",
            preferredSource: "omdb",
          },
          alternatives: [
            {
              value: "7.2",
              sourceIdentity: "tmdb",
              sourceRecordIds: ["tmdb-record"],
              sourceSlot: "tmdb.vote-average",
              exclusion: {
                kind: "source-preference",
                selectedSource: "omdb",
                disagreesWithSelected: true,
              },
            },
          ],
        },
      ],
      metadataPolicyConflicts: [
        {
          kind: "policy-conflict",
          property: "asset.title",
          metadataUsageContext: "asset.ordinary",
          policyIds: ["first", "second"],
          candidates: [
            {
              assertion: {
                property: "asset.title",
                sourceSlot: "tmdb.title",
                value: "怒火救援",
                sourceRecordIds: ["tmdb-record"],
              },
              value: "怒火救援",
              sourceIdentity: "tmdb",
              sourceRecordIds: ["tmdb-record"],
              sourceSlot: "tmdb.title",
            },
          ],
          explanation: "incomparable",
        },
      ],
      entities: [],
      relationships: [],
      recognitionExplanation: "已由严格目录规则识别",
      artifacts: [],
      locations: [],
      artifactAssociations: [],
    };
    const application = {
      openAssetRefresh() {
        return {
          async refreshMetadata() {
            return {
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
    expect(output.stdout()).toContain("tmdb：tmdb:9509");
    expect(output.stdout()).toContain("omdb：omdb:tt0328107");
    expect(output.stdout()).toContain(
      "asset.rating：7.7（omdb；记录 omdb-record；来源位置 omdb.rating）",
    );
    expect(output.stdout()).toContain("选择依据：采用首选来源 omdb");
    expect(output.stdout()).toContain(
      "其他来源：7.2（tmdb；记录 tmdb-record；来源位置 tmdb.vote-average；与当前值不一致；因来源顺序未采用）",
    );
    expect(output.stdout()).toContain(
      "asset.title：规则 first、second 尚未确定先后，当前没有采用值",
    );
  });
});
