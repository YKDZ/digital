import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { captureRawFilesystemSnapshot } from "@digital/test-support";

import { prepareCliProductData } from "../../prepare-catalogue.ts";
import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyResult,
} from "../journey.ts";

const resumableStages = new Set([
  "source-records-retained",
  "source-artifacts-acquired",
  "source-artifacts-stored",
  "cover-acquired",
  "cover-stored",
]);

type InterruptedExecution = {
  readonly dataDirectory: string;
  readonly executionId: string;
  readonly stage: string;
  readonly source: string;
  readonly sourceBaseline: readonly string[];
  readonly terminalFailureSource: string;
  readonly killedCheckpoint: DurableState;
};

type DurableState = {
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly sourceRecordIds: readonly string[];
  readonly managedFiles: readonly string[];
};

const interruptedByWorkDirectory = new Map<string, InterruptedExecution>();

function sourceDirectory(context: Parameters<CliJourney["setup"]>[0]): string {
  return path.resolve(
    context.packageRoot,
    "../..",
    ".scratch/acceptance-corpus/assets/kikoeru/VoiceWork/RJ01668691",
  );
}

async function fingerprintTree(root: string): Promise<readonly string[]> {
  return (
    await captureRawFilesystemSnapshot(root, { contentDigests: true })
  ).entries
    .filter((entry) => entry.relativePath !== ".")
    .map((entry) =>
      entry.kind === "directory"
        ? `${entry.relativePath}/`
        : `${entry.relativePath}:${entry.kind}:${entry.byteLength}:${entry.modifiedAtNanoseconds}:${entry.symbolicLinkTarget ?? ""}:${entry.contentDigest ?? ""}`,
    );
}

async function durableState(dataDirectory: string): Promise<DurableState> {
  const database = new DatabaseSync(
    path.join(dataDirectory, "catalogue.sqlite"),
    { readOnly: true },
  );
  try {
    const tables = [
      "source_records",
      "recognition_decisions",
      "artifacts",
      "locations",
      "artifact_associations",
      "metadata_assertions",
      "entity_relationships",
    ] as const;
    return {
      tableCounts: Object.fromEntries(
        tables.map((table) => [
          table,
          (
            database
              .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
              .get() as {
              readonly count: number;
            }
          ).count,
        ]),
      ),
      sourceRecordIds: (
        database
          .prepare("SELECT id FROM source_records ORDER BY id")
          .all() as unknown as readonly { readonly id: string }[]
      ).map((row) => row.id),
      managedFiles: await managedFiles(
        path.join(dataDirectory, "managed-artifacts"),
      ),
    };
  } finally {
    database.close();
  }
}

async function managedFiles(root: string): Promise<readonly string[]> {
  try {
    return (await fingerprintTree(root)).filter(
      (item) => !item.endsWith("/") && !item.startsWith("staging/"),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

function cliInvocation(context: Parameters<CliJourney["setup"]>[0]): {
  readonly executable: string;
  readonly prefix: readonly string[];
} {
  return context.mode === "source"
    ? {
        executable: process.execPath,
        prefix: [
          "--conditions=digital-source",
          path.join(context.packageRoot, "src", "cli.ts"),
        ],
      }
    : {
        executable: process.execPath,
        prefix: [path.join(context.packageRoot, "dist", "cli.js")],
      };
}

function executionId(result: CliJourneyResult | undefined): string {
  const output = JSON.parse(result?.stdout ?? "{}") as {
    readonly executionId?: string;
  };
  if (output.executionId === undefined)
    throw new Error(`expected execution id in ${result?.stdout ?? ""}`);
  return output.executionId;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function interruptAtPersistedCheckpoint(
  context: Parameters<CliJourney["setup"]>[0],
  sourceRootId: string,
  dataDirectory: string,
): Promise<{ readonly executionId: string; readonly stage: string }> {
  const target = cliInvocation(context);
  const child = spawn(
    target.executable,
    [
      ...target.prefix,
      "scan",
      sourceRootId,
      "--scope",
      ".",
      "--require-artifact-role",
      "asset.primary-cover",
      "--json",
    ],
    {
      cwd: context.workDir,
      env: { ...process.env, DIGITAL_PRODUCT_DATA: dataDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 30_000;
  // 此看门狗在持久检查点观察子 CLI 进程。它刻意不是另一个已组合运行时：运行时初始化
  // 拥有迁移闸门（`BEGIN IMMEDIATE`），自身会与子检查点写入器争用。之后的 CLI `resume`
  // 和 `inspect` 命令仍是重启端到端边界；该观察器只读取已提交阶段。
  let observer: DatabaseSync | undefined;
  let executionId: string | undefined;
  try {
    while (Date.now() < deadline) {
      const found = /刷新记录：([^\s]+)/u.exec(stderr)?.[1];
      if (found !== undefined) executionId = found;
      if (executionId !== undefined) {
        observer ??= new DatabaseSync(
          path.join(dataDirectory, "catalogue.sqlite"),
          { readOnly: true },
        );
        const execution = observer
          .prepare("SELECT status, stage FROM workflow_executions WHERE id = ?")
          .get(executionId) as
          | { readonly status: string; readonly stage: string }
          | undefined;
        if (
          execution?.status === "running" &&
          resumableStages.has(execution.stage)
        ) {
          child.kill("SIGKILL");
          const outcome = await closed;
          assert.equal(outcome.signal, "SIGKILL");
          return { executionId, stage: execution.stage };
        }
        if (execution?.status !== undefined && execution.status !== "running") {
          throw new Error(
            `CLI completed before interruption at a resumable checkpoint: ${execution.status}/${execution.stage}`,
          );
        }
      }
      await sleep(15);
    }
    child.kill("SIGKILL");
    await closed;
    throw new Error(
      `CLI did not expose a resumable checkpoint before timeout: ${stderr}`,
    );
  } finally {
    observer?.close();
  }
}

async function registerObservedRoot(input: {
  readonly context: Parameters<CliJourney["setup"]>[0];
  readonly dataDirectory: string;
  readonly displayName: string;
  readonly containerPath: string;
}): Promise<string> {
  const target = cliInvocation(input.context);
  const result = await new Promise<CliJourneyResult>((resolve, reject) => {
    const child = spawn(
      target.executable,
      [...target.prefix, "root-create", input.displayName, input.containerPath],
      {
        cwd: input.context.workDir,
        env: { ...process.env, DIGITAL_PRODUCT_DATA: input.dataDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        commandName: "register interrupted refresh source root",
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return registeredObservedRootId(result);
}

function current(
  context: Parameters<CliJourney["setup"]>[0],
): InterruptedExecution {
  const state = interruptedByWorkDirectory.get(context.workDir);
  if (state === undefined)
    throw new Error("interrupted execution was not set up");
  return state;
}

const journey: CliJourney = {
  name: "resume-interrupted-refresh",
  modes: ["source", "distribution"],
  async setup(context) {
    const source = sourceDirectory(context);
    if (!(await stat(source)).isDirectory())
      throw new Error(`required live acceptance corpus is missing: ${source}`);
    const sourceBaseline = await fingerprintTree(source);
    const dataDirectory = path.join(context.workDir, "product-data");
    await prepareCliProductData(dataDirectory);
    const terminalFailureSource = path.join(
      context.workDir,
      "terminal-failure-source",
    );
    await mkdir(terminalFailureSource);
    await writeFile(
      path.join(terminalFailureSource, "ordinary.txt"),
      "ordinary unresolved material\n",
    );
    const sourceRootId = await registerObservedRoot({
      context,
      dataDirectory,
      displayName: "RJ01668691 恢复测试语料",
      containerPath: source,
    });
    const interrupted = await interruptAtPersistedCheckpoint(
      context,
      sourceRootId,
      dataDirectory,
    );
    interruptedByWorkDirectory.set(context.workDir, {
      dataDirectory,
      source,
      sourceBaseline,
      terminalFailureSource,
      killedCheckpoint: await durableState(dataDirectory),
      ...interrupted,
    });
  },
  commands(context) {
    const state = current(context);
    return [
      {
        name: "register terminal failed refresh root",
        args: ["root-create", "终端失败测试目录", state.terminalFailureSource],
        env: { DIGITAL_PRODUCT_DATA: state.dataDirectory },
        haltOnFailure: true,
      },
      {
        name: "resume interrupted refresh in a second CLI process",
        args: ["resume", state.executionId, "--json"],
        env: { DIGITAL_PRODUCT_DATA: state.dataDirectory },
      },
      {
        name: "inspect resumed refresh in a third CLI process",
        args: ["inspect", state.executionId, "--json"],
        env: { DIGITAL_PRODUCT_DATA: state.dataDirectory },
      },
      {
        // 这个预期终态失败刻意产出供下一命令检查的执行 ID；它不得中止反向路径旅程。
        name: "create a terminal failed metadata refresh",
        args: ["refresh-metadata", "missing-terminal-subject", "--json"],
        env: { DIGITAL_PRODUCT_DATA: state.dataDirectory },
      },
      {
        name: "reject resuming the terminal failure",
        args: (results) => ["resume", executionId(results[2]), "--json"],
        env: { DIGITAL_PRODUCT_DATA: state.dataDirectory },
      },
      {
        name: "start another ordinary refresh after terminal failure",
        args: (results) => [
          "scan",
          registeredObservedRootId(results[0]),
          "--scope",
          ".",
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: state.dataDirectory },
      },
    ];
  },
  async assertions({ context, results: allResults }) {
    assert.equal(allResults[0]?.exitCode, 0, allResults[0]?.stderr);
    registeredObservedRootId(allResults[0]);
    const results = allResults.slice(1);
    const state = current(context);
    const resumed = JSON.parse(results[0]?.stdout ?? "{}") as {
      readonly executionId?: string;
      readonly execution?: {
        readonly status?: string;
        readonly outcome?: string;
        readonly stage?: string;
      };
      readonly sourceRecords?: readonly { readonly id: string }[];
      readonly accepted?: {
        readonly entity?: { readonly id: string };
        readonly artifacts?: readonly { readonly id: string }[];
        readonly locations?: readonly { readonly id: string }[];
        readonly artifactAssociations?: readonly { readonly id: string }[];
      };
    };
    const inspected = JSON.parse(results[1]?.stdout ?? "{}") as typeof resumed;
    assert.equal(results[0]?.exitCode, 0, results[0]?.stderr);
    assert.equal(resumed.executionId, state.executionId);
    assert.equal(resumed.execution?.status, "completed");
    assert.equal(resumed.execution?.outcome, "accepted");
    assert.equal(resumed.sourceRecords?.length, 2);
    assert.ok(resumed.accepted?.entity?.id);
    assert.doesNotMatch(results[0]?.stderr ?? "", /正在获取官方来源/u);
    assert.doesNotMatch(
      JSON.stringify(resumed),
      /"body"|"acquisition"|credential|cookie|plugin/u,
    );
    assert.equal(results[1]?.exitCode, 0, results[1]?.stderr);
    assert.deepEqual(inspected, resumed);
    assert.equal(
      state.killedCheckpoint.tableCounts.source_records,
      state.killedCheckpoint.sourceRecordIds.length,
      `killed checkpoint ${state.stage} contains duplicate source rows`,
    );
    const completedState = await durableState(state.dataDirectory);
    assert.deepEqual(
      completedState.sourceRecordIds,
      state.killedCheckpoint.sourceRecordIds,
      `resume after ${state.stage} must reuse committed Source Records`,
    );
    assert.equal(completedState.tableCounts.source_records, 2);
    assert.equal(completedState.tableCounts.recognition_decisions, 1);
    assert.equal(
      completedState.tableCounts.artifacts,
      resumed.accepted?.artifacts?.length,
    );
    assert.equal(
      completedState.tableCounts.locations,
      resumed.accepted?.locations?.length,
    );
    assert.equal(
      completedState.tableCounts.artifact_associations,
      resumed.accepted?.artifactAssociations?.length,
    );
    assert.equal(
      new Set(resumed.accepted?.artifactAssociations?.map((item) => item.id))
        .size,
      resumed.accepted?.artifactAssociations?.length,
    );
    assert.equal(completedState.managedFiles.length, 1);

    const failed = JSON.parse(results[2]?.stdout ?? "{}") as {
      readonly executionId?: string;
      readonly execution?: {
        readonly status?: string;
        readonly outcome?: string;
      };
    };
    assert.equal(results[2]?.exitCode, 1, results[2]?.stderr);
    assert.equal(failed.execution?.status, "failed");
    assert.equal(failed.execution?.outcome, "failed");
    assert.notEqual(failed.executionId, state.executionId);
    assert.equal(results[3]?.exitCode, 1);
    assert.match(results[3]?.stderr ?? "", /只有未完成的刷新记录可以继续/u);

    const next = JSON.parse(results[4]?.stdout ?? "{}") as {
      readonly executionId?: string;
      readonly execution?: {
        readonly outcome?: string;
        readonly selection?: { readonly intent?: string };
      };
    };
    assert.equal(results[4]?.exitCode, 0, results[4]?.stderr);
    assert.notEqual(next.executionId, failed.executionId);
    assert.equal(next.execution?.selection?.intent, "scan-now");
    assert.ok(next.execution?.outcome === "unresolved");
    assert.deepEqual(await fingerprintTree(state.source), state.sourceBaseline);
  },
};

export default journey;
