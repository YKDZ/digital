import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  intakeDirectories,
  type IntakeOutcome,
  type JsonObject,
  type JsonValue,
  type ProductClient,
} from "./preview-product.ts";

/** 输入选择和正式接入属于预览调用方；环境能力不读取作品、响应或预期。 */
export const previewCorpusDirectory = path.resolve(
  import.meta.dirname,
  "../fixtures/preview-corpus",
);
export const previewCorpusManifest = path.join(
  previewCorpusDirectory,
  "manifest.json",
);

export type PreviewCorpusCase = {
  readonly id: string;
  readonly kind:
    | "audio"
    | "post"
    | "unrecognized"
    | "epub"
    | "pdf"
    | "anime"
    | "film";
  readonly directory: string;
  readonly directed?: boolean;
  readonly tmdb?: number;
  readonly official?: { readonly isbn: string };
};
type CoverageRoot = {
  readonly id: string;
  readonly batch: "audio-posts" | "publication-screen";
  readonly directory: string;
  readonly recognition: "required" | "unrecognized";
  readonly case: { readonly file: string; readonly index: number };
};
const coverage = JSON.parse(
  readFileSync(path.join(previewCorpusDirectory, "coverage.json"), "utf8"),
) as { readonly roots: readonly CoverageRoot[] };
export const defaultPreviewMaterials = coverage.roots.map((root) =>
  path.join(previewCorpusDirectory, root.directory),
);

export function previewCorpusCases(directories: readonly string[]): readonly {
  readonly root: CoverageRoot;
  readonly fixture: string;
  readonly item: PreviewCorpusCase;
}[] {
  return directories.flatMap((directory) => {
    const root = coverage.roots.find(
      (candidate) =>
        path.join(previewCorpusDirectory, candidate.directory) === directory,
    );
    if (root === undefined) return [];
    const source = JSON.parse(
      readFileSync(path.join(previewCorpusDirectory, root.case.file), "utf8"),
    ) as {
      readonly cases: readonly PreviewCorpusCase[];
    };
    const item = source.cases[root.case.index];
    assert(item?.id === root.id, `共同索引与原资料条目不一致：${root.id}`);
    return [
      { root, item, fixture: path.join(previewCorpusDirectory, root.batch) },
    ];
  });
}

const object = (value: JsonValue | undefined): JsonObject => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
};
const array = (value: JsonValue | undefined): readonly JsonValue[] => {
  assert(Array.isArray(value));
  return value;
};
const string = (value: JsonValue | undefined): string => {
  assert.equal(typeof value, "string");
  return value as string;
};

/** 已存在（包括撤销、不可用）的配置由使用者持有，预览不能暗中替换或恢复。 */
async function connectionNeedsConfiguration(
  client: ProductClient,
  id: string,
): Promise<boolean> {
  const settings = await client.get("/settings");
  assert.equal(settings.status, 200);
  const connection = array(object(settings.body)["sources"])
    .map(object)
    .find((source) => source["id"] === id);
  return (
    connection === undefined ||
    connection["credentialStatus"] === "unconfigured"
  );
}

export async function configureAudioPostSources(
  client: ProductClient,
  fixture: string,
  cases: readonly PreviewCorpusCase[],
): Promise<void> {
  if (
    !cases.some((item) => item.kind === "post") ||
    !(await connectionNeedsConfiguration(client, "fanbox/customudon"))
  )
    return;
  const browserCredential = JSON.parse(
    await readFile(
      path.join(fixture, "connections/synthetic-customudon.json"),
      "utf8",
    ),
  ) as JsonObject;
  const connection = await client.post("/settings/connections", {
    source: "fanbox",
    action: "configure",
    creatorId: "customudon",
    browserCredential,
  });
  assert.equal(connection.status, 200);
}

export async function configurePublicationScreenSources(
  client: ProductClient,
  cases: readonly PreviewCorpusCase[],
  port: number,
): Promise<readonly JsonValue[]> {
  const configured: JsonValue[] = [];
  if (cases.some((c) => c.kind === "film")) {
    for (const source of ["tmdb", "omdb"]) {
      if (!(await connectionNeedsConfiguration(client, source))) continue;
      const result = await client.post("/settings/connections", {
        source,
        action: "configure",
        secret:
          source === "tmdb" ? "synthetic-tmdb-token" : "synthetic-omdb-key",
      });
      assert.equal(result.status, 200);
      configured.push({ source, inspection: result.body });
    }
  }
  if (
    cases.some((c) => c.kind === "anime") &&
    (await connectionNeedsConfiguration(client, "bangumi"))
  ) {
    assert.equal(
      (
        await client.post("/settings/connections", {
          source: "bangumi",
          action: "configure-client",
          clientId: "synthetic-client",
          clientSecret: "synthetic-client-secret",
          redirectUri: `http://127.0.0.1:${String(port)}/api/source-connections/bangumi/callback`,
        })
      ).status,
      200,
    );
    const authorization = await client.post(
      "/source-connections/bangumi/authorize",
      {},
    );
    assert.equal(authorization.status, 201);
    const state = new URL(
      string(object(authorization.body)["authorizationUrl"]),
    ).searchParams.get("state");
    assert(state);
    const callback = await client.get("/source-connections/bangumi/callback", {
      code: "synthetic-code",
      state,
    });
    assert.equal(callback.status, 200);
    configured.push({ source: "bangumi", inspection: callback.body });
  }
  return configured;
}

export async function intakeAudioPostCase(
  client: ProductClient,
  fixture: string,
  item: PreviewCorpusCase,
  workflowTimeoutMs = 300_000,
  displayName = `轻量资料 ${item.id}`,
): Promise<IntakeOutcome> {
  return await intakeDirectories(client, {
    displayName,
    directories: [path.join(fixture, item.directory)],
    recognitionProfileIds:
      item.kind === "audio"
        ? ["dlsite-voice"]
        : item.kind === "post"
          ? ["fanbox"]
          : ["dlsite-voice", "fanbox", "books", "anime", "movies"],
    sourceIdentities: ["dlsite", "fanbox"],
    workflowTimeoutMs,
  });
}

export async function intakePublicationScreenCase(
  client: ProductClient,
  fixture: string,
  item: PreviewCorpusCase,
  workflowTimeoutMs = 300_000,
  displayName = `出版物与影视资料 ${item.id}`,
): Promise<{
  readonly intake: IntakeOutcome;
  readonly operations: Readonly<Record<string, unknown>>;
}> {
  const intake = await intakeDirectories(client, {
    displayName,
    directories: [path.join(fixture, item.directory)],
    recognitionProfileIds: [
      item.kind === "anime"
        ? "anime"
        : item.kind === "film"
          ? "movies"
          : "books",
    ],
    sourceIdentities:
      item.kind === "anime"
        ? ["bangumi"]
        : item.kind === "film"
          ? ["tmdb", "omdb"]
          : ["nbinet"],
    workflowTimeoutMs,
  });
  const operations: Record<string, unknown> = {};
  const rootId = intake.observedRootIds[0];
  assert(rootId);
  if (item.directed && !intake.reused) {
    assert.equal(intake.assetIds.length, 0, "非规范收藏包不应自动制造资产");
    const directed = await client.post("/refresh", {
      observedRootId: rootId,
      relativeScope: ".",
      directedSourceIdentity: "tmdb",
      directedSourceInput: { movie: String(item.tmdb) },
    });
    operations["directed"] = directed;
    assert.equal(directed.status, 201);
    const execution = await client.awaitExecution(
      string(object(directed.body)["id"]),
      workflowTimeoutMs,
    );
    operations["directedExecution"] = execution;
    assert.equal(execution.status, "completed");
    assert.equal(execution.outcome, "accepted");
  }
  if (item.official && !intake.reused) {
    const observed = await client.get("/intake", { rootId });
    assert.equal(observed.status, 200);
    const assetIds = [
      ...new Set(
        array(object(observed.body)["files"]).flatMap((file) =>
          array(object(file)["assetIds"]).map(string),
        ),
      ),
    ];
    assert(assetIds[0]);
    const enrichment = await client.post("/source-enrichments", {
      subjectId: assetIds[0],
      sourceIdentity: "nbinet",
      sourceInput: { isbn: item.official.isbn },
      assetLibraryId: intake.assetLibraryId,
    });
    operations["enrichment"] = enrichment;
    assert.equal(enrichment.status, 201);
    const execution = await client.awaitExecution(
      string(object(enrichment.body)["id"]),
      workflowTimeoutMs,
    );
    operations["enrichmentExecution"] = execution;
    assert.equal(execution.status, "completed");
    assert.equal(execution.outcome, "accepted");
  }
  return { intake, operations };
}
