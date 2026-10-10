import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import type { OperationCancellation } from "./cancellation.ts";
import {
  invalidEnvironmentFacts,
  noRunFacts,
  recordedRunFacts,
  type EnvironmentFacts,
  type RebuildFailureStage,
  type RebuildOperationResult,
  type RebuildRequest,
} from "./operation-contract.ts";
import {
  derivedFacts,
  describeError,
  directoryIdentity,
  environmentFacts,
  listFiles,
  note,
  saveRecord,
} from "./operation-support.ts";
import {
  createLayout,
  createOperationId,
  overlaps,
  verifyDataOwnership,
  verifyLogsOwnership,
  type EnvironmentLayout,
} from "./paths.ts";
import {
  runPreparationStages,
  type StageContext,
} from "./prepare-operation.ts";
import type { HeldCommands } from "./processes.ts";
import { assertProductRootOffline } from "./product-offline.ts";
import {
  readRecord,
  type DestructiveIntent,
  type EnvironmentRecord,
} from "./record.ts";
import { createDiagnosticRedactor } from "./redact.ts";
import { observeLiveness } from "./run-observation.ts";

/**
 * 重建已停止的自有环境：核验归属与离线后先持久重建意图，回收旧自有产品数据根，
 * 再从空根走与准备完全相同的正式构建、正式迁移、正式读取，成功才发布保留同一
 * 环境身份的新数据世代。普通 inputs/config 保留；运行日志保留；不扫描输入、
 * 不自动接入资料、不写业务表。运行中、启动中、停止未确认或身份未知一律拒绝。
 * 三个阶段命令沿用准备同一份取消条件：只在约定期限到期或本操作进程被要求终止时成立。
 */
export async function runRebuildOperation(
  request: RebuildRequest,
  held: HeldCommands,
  cancellation: OperationCancellation,
): Promise<RebuildOperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  if ("reason" in layout)
    return outerFailure(
      request,
      layout,
      "invalid-request",
      "request",
      layout.reason,
    );
  const read = await readRecord(layout.recordPath);
  if (read.kind === "corrupt")
    return outerFailure(
      request,
      layout,
      "unmanaged",
      "claim",
      `环境记录损坏或版本未知，保留原件不接管：${read.reason}`,
    );
  if (read.kind === "absent")
    return outerFailure(
      request,
      layout,
      "refused",
      "claim",
      "该环境没有准备记录，没有可重建的自有数据世代；请通过 prepare 建立新环境",
    );

  const record = read.record;
  const container = await directoryIdentity(layout.containerDirectory);
  if (
    container === undefined ||
    record.workspacePath !== layout.workspacePath ||
    record.environment !== layout.environment ||
    record.containerIdentity.device !== container.device ||
    record.containerIdentity.inode !== container.inode
  )
    return outerFailure(
      request,
      layout,
      "unmanaged",
      "claim",
      "环境记录与当前容器身份不一致，拒绝接管",
      environmentFacts(record, layout),
      recordedRunFacts(record),
    );

  const facts = environmentFacts(record, layout);
  const busy = rebuildBlockedByRun(record);
  if (busy !== undefined)
    return outerFailure(
      request,
      layout,
      "refused",
      "generation",
      busy,
      facts,
      recordedRunFacts(record),
    );
  if (record.destructive?.kind === "delete")
    return outerFailure(
      request,
      layout,
      "refused",
      "generation",
      `该环境存在未收敛的删除意图（操作 ${record.destructive.operationId}），重建拒绝在半删除现场上继续；请用显式 delete 收敛`,
      facts,
      recordedRunFacts(record),
    );
  // 数据根被重定向或与素材重叠时不得回收：保留两侧内容并报告归属问题。
  const ownership = await verifyDataOwnership(layout, record.inputs);
  if ("reason" in ownership)
    return outerFailure(
      request,
      layout,
      "unmanaged",
      "claim",
      ownership.reason,
      facts,
      recordedRunFacts(record),
    );
  // 日志根同样必须在第一次日志写入之前确认归属：预先重定向会把操作诊断投到素材里。
  const logs = await verifyLogsOwnership(layout, record.inputs);
  if ("reason" in logs)
    return outerFailure(
      request,
      layout,
      "unmanaged",
      "claim",
      logs.reason,
      facts,
      recordedRunFacts(record),
    );

  const operationId = createOperationId(new Date());
  const logDirectory = path.join(layout.logsRoot, operationId);
  const operationLog = path.join(logDirectory, "operation.log");
  const logErrors: string[] = [];
  try {
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  } catch (error) {
    return outerFailure(
      request,
      layout,
      "failed",
      "operation",
      `重建操作日志目录无法建立：${describeError(error)}`,
      facts,
      recordedRunFacts(record),
    );
  }
  const noted = (message: string): Promise<void> =>
    note(operationLog, logErrors, message);
  await noted(
    `rebuild ${layout.environment} 开始（操作 ${operationId}，目标数据世代 ${record.dataGeneration}）`,
  );

  // 意图落盘之前只做无副作用的离线核验：被拒绝时记录保持原样。
  const offline = await assertProductRootOffline({
    layout,
    inputs: record.inputs,
    // 只有本管理器已经写下重建意图的重入才可能是自己的部分回收残余。
    continuationEligible: record.destructive !== undefined,
    logFile: path.join(logDirectory, "offline-check.log"),
    held,
  });
  if ("reason" in offline) {
    await noted(`重建被拒绝（未改动任何内容）：${offline.reason}`);
    return {
      kind: "rebuild",
      status: "refused",
      environment: facts,
      run: recordedRunFacts(record),
      failure: {
        stage: "offline",
        message: redact(offline.reason),
        exitCode: null,
      },
      cleanup: { state: "not-started", errors: [] },
      logs: {
        directory: logDirectory,
        files: await listFiles(logDirectory, logErrors),
      },
      diagnostics: [...logErrors],
    };
  }
  if ("ownResidue" in offline)
    await noted(
      "上次回收已把自有数据根删成残余（正式备份判定副本源不完整、维护准入已通过）；本次重建按同一意图继续",
    );

  const intent = buildRebuildIntent(record, operationId);
  const baseRecord: EnvironmentRecord = {
    version: 1,
    environmentId: record.environmentId,
    workspacePath: layout.workspacePath,
    environment: layout.environment,
    createdAt: record.createdAt,
    containerIdentity: container,
    inputs: record.inputs,
    sourceMode: record.sourceMode,
    config: record.config,
    dataGeneration: record.dataGeneration,
    ...(record.run === undefined ? {} : { run: record.run }),
    destructive: intent,
    preparation: {
      state: "preparing",
      updatedAt: intent.startedAt,
      lastOperationId: operationId,
    },
    operations: [
      ...record.operations.map((operation) =>
        operation.id === record.preparation.lastOperationId &&
        operation.finishedAt === undefined
          ? {
              ...operation,
              finishedAt: intent.startedAt,
              outcome: "interrupted" as const,
            }
          : operation,
      ),
      {
        id: operationId,
        kind: "rebuild" as const,
        startedAt: intent.startedAt,
        logDirectory: path.posix.join("logs", operationId),
      },
    ],
  };
  const intentProblem = await saveRecord(layout.recordPath, baseRecord);
  if (intentProblem !== undefined) {
    await noted(`重建意图无法写入记录，未做任何破坏性改动：${intentProblem}`);
    return {
      kind: "rebuild",
      status: "failed",
      environment: facts,
      run: recordedRunFacts(record),
      failure: {
        stage: "intent",
        message: redact(`写入重建意图失败：${intentProblem}`),
        exitCode: null,
      },
      cleanup: { state: "not-started", errors: [] },
      logs: {
        directory: logDirectory,
        files: await listFiles(logDirectory, logErrors),
      },
      diagnostics: [...logErrors],
    };
  }
  await noted("重建意图已持久；开始回收旧自有产品数据根");

  const purgeProblem = await purgeOwnedProductData(layout, baseRecord);
  if (purgeProblem !== undefined) {
    await noted(`旧数据根回收未完成：${purgeProblem}`);
    const cleanup = await held.close();
    return {
      kind: "rebuild",
      status: "not-confirmed",
      environment: facts,
      run: recordedRunFacts(baseRecord),
      failure: {
        stage: "purge",
        message: redact(purgeProblem),
        exitCode: null,
      },
      cleanup,
      logs: {
        directory: logDirectory,
        files: await listFiles(logDirectory, logErrors),
      },
      diagnostics: [...logErrors],
    };
  }
  await noted("旧自有产品数据根已回收；从空根执行正式构建、迁移与读取");

  const context: StageContext = {
    request: {
      kind: "prepare",
      workspacePath: layout.workspacePath,
      environment: layout.environment,
      inputs: record.inputs,
      sourceMode: record.sourceMode,
      config: record.config,
    },
    layout,
    baseRecord,
    operationLog,
    logErrors,
    interruptedOperationIds: record.operations
      .filter(
        (operation) =>
          operation.id === record.preparation.lastOperationId &&
          operation.finishedAt === undefined,
      )
      .map((operation) => operation.id),
  };
  const staged = await runPreparationStages(
    context,
    held,
    cancellation,
    "rebuilt",
  );
  if (staged.status !== "prepared") {
    const failure = staged.failure ?? {
      stage: "operation" as const,
      message: "重建的准备阶段没有交出具体失败说明",
      exitCode: null,
    };
    return {
      kind: "rebuild",
      status: staged.cleanup.state === "unknown" ? "not-confirmed" : "failed",
      environment: staged.environment,
      run: recordedRunFacts(baseRecord),
      failure: {
        stage: failure.stage,
        message: failure.message,
        exitCode: failure.exitCode,
      },
      cleanup: staged.cleanup,
      logs: staged.logs,
      diagnostics: [...staged.diagnostics, ...logErrors],
    };
  }

  // 三阶段成功：只有此时才发布新数据世代并收敛重建意图。任何偏差都保留现场，
  // 交给下一次显式 rebuild 按同一意图继续。
  const reloaded = await readRecord(layout.recordPath);
  if (
    reloaded.kind !== "record" ||
    reloaded.record.preparation.state !== "prepared" ||
    reloaded.record.preparation.lastOperationId !== operationId ||
    reloaded.record.destructive?.operationId !== operationId
  )
    return notConfirmedFinalize(
      layout,
      baseRecord,
      logDirectory,
      logErrors,
      held,
      reloaded.kind === "corrupt"
        ? `重建阶段完成后记录变得不可读：${reloaded.reason}`
        : "重建阶段完成后记录内容与本次操作不符，无法确认已准备提交属于本次重建",
    );
  const committed = reloaded.record;
  const finalRecord: EnvironmentRecord = {
    version: 1,
    environmentId: committed.environmentId,
    workspacePath: committed.workspacePath,
    environment: committed.environment,
    createdAt: committed.createdAt,
    containerIdentity: committed.containerIdentity,
    inputs: committed.inputs,
    sourceMode: committed.sourceMode,
    config: committed.config,
    dataGeneration: nextGeneration(committed.dataGeneration),
    ...(committed.run === undefined ? {} : { run: committed.run }),
    preparation: committed.preparation,
    operations: committed.operations,
  };
  const finalProblem = await saveRecord(layout.recordPath, finalRecord);
  if (finalProblem !== undefined)
    return notConfirmedFinalize(
      layout,
      baseRecord,
      logDirectory,
      logErrors,
      held,
      `新数据世代无法写入记录，重建意图保留：${finalProblem}`,
    );
  await noted(
    `已重建：新数据世代 ${finalRecord.dataGeneration}（已准备，不代表服务就绪）`,
  );
  return {
    kind: "rebuild",
    status: "rebuilt",
    environment: environmentFacts(finalRecord, layout),
    run: recordedRunFacts(finalRecord),
    cleanup: staged.cleanup,
    logs: {
      directory: logDirectory,
      files: await listFiles(logDirectory, logErrors),
    },
    diagnostics: [...logErrors],
  };
}

function buildRebuildIntent(
  record: EnvironmentRecord,
  operationId: string,
): DestructiveIntent {
  return {
    kind: "rebuild",
    operationId,
    startedAt: new Date().toISOString(),
    targetDataGeneration: record.dataGeneration,
    targetRunId: record.run?.runId ?? null,
  };
}

/** 数据世代只按 g<数字> 递增；无法识别的历史值以显式新序列重新开始。 */
function nextGeneration(current: string): string {
  const match = /^g([0-9]+)$/u.exec(current);
  if (match === null) return "g2";
  return `g${String(Number(match[1]) + 1)}`;
}

/**
 * 回收旧自有产品数据根：每一处判定都以容器内规范路径为准；身份、符号链接或
 * 重叠发生任何变化都不删除，只报告未完成。删除不完整时下一次 rebuild 继续同一目标。
 */
async function purgeOwnedProductData(
  layout: EnvironmentLayout,
  record: EnvironmentRecord,
): Promise<string | undefined> {
  const root = layout.productDataRoot;
  if (!root.startsWith(`${layout.containerDirectory}${path.sep}`))
    return `数据根不在容器之内，拒绝回收：${root}`;
  let existing: Awaited<ReturnType<typeof lstat>>;
  try {
    existing = await lstat(root);
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return undefined;
    return `数据根无法核验，未回收：${root}（${describeError(error)}）`;
  }
  if (!existing.isDirectory())
    return `数据根不是环境自有目录，归属已变化，未回收：${root}`;
  let resolved: string;
  try {
    resolved = await realpath(root);
  } catch (error) {
    return `数据根无法解析，未回收：${root}（${describeError(error)}）`;
  }
  if (resolved !== root)
    return `数据根已指向所选环境之外的位置，未回收：${root} → ${resolved}`;
  for (const input of record.inputs)
    if (overlaps(resolved, input))
      return `数据根与输入素材重叠，未回收：${resolved} ↔ ${input}`;
  try {
    await rm(root, { recursive: true });
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return undefined;
    return `数据根回收失败，保留现场：${root}（${describeError(error)}）`;
  }
  try {
    await lstat(root);
    return `数据根回收后仍然存在，结果未确认：${root}`;
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    return code === "ENOENT"
      ? undefined
      : `数据根回收后无法核验其不存在：${root}（${describeError(error)}）`;
  }
}

/**
 * 重建拒绝在收尾未确认的世代上破坏：活服务、启动中、停止未确认或身份未知都
 * 要求先经公开 stop 独立确认真实退出。
 */
function rebuildBlockedByRun(record: EnvironmentRecord): string | undefined {
  const run = record.run;
  if (run === undefined) return undefined;
  const liveness = observeLiveness(run.processIdentity);
  if (run.state === "stopped") {
    return liveness === "alive"
      ? "记录已标记为已停止但进程身份显示存活，停止结论未确认；请先用公开 stop 独立确认退出"
      : undefined;
  }
  if (run.state === "starting" || run.state === "stopping")
    return `本环境记录显示服务正在${run.state === "starting" ? "启动" : "停止"}，重建拒绝在收尾未确认时改动环境；请先用公开 stop 独立确认退出`;
  return liveness === "exited"
    ? undefined
    : liveness === "alive"
      ? `本环境已有受记录管理的运行中服务（世代 ${run.runId}），先停止再重建`
      : `无法确认本环境受记录管理的进程是否仍在运行，重建拒绝改动环境；请先用公开 stop 独立确认`;
}

async function notConfirmedFinalize(
  layout: EnvironmentLayout,
  baseRecord: EnvironmentRecord,
  logDirectory: string,
  logErrors: string[],
  held: HeldCommands,
  reason: string,
): Promise<RebuildOperationResult> {
  await note(path.join(logDirectory, "operation.log"), logErrors, reason);
  const cleanup = await held.close();
  return {
    kind: "rebuild",
    status: "not-confirmed",
    environment: environmentFacts(baseRecord, layout),
    run: recordedRunFacts(baseRecord),
    failure: { stage: "operation", message: redact(reason), exitCode: null },
    cleanup,
    logs: {
      directory: logDirectory,
      files: await listFiles(logDirectory, logErrors),
    },
    diagnostics: [...logErrors],
  };
}

/** 意图落盘之前的结果：记录与现场都保持原样，不谎报日志位置。 */
function outerFailure(
  request: RebuildRequest,
  layout: EnvironmentLayout | { readonly reason: string },
  status: "refused" | "failed" | "unmanaged" | "invalid-request",
  stage: RebuildFailureStage,
  reason: string,
  facts?: EnvironmentFacts,
  run?: ReturnType<typeof recordedRunFacts>,
): RebuildOperationResult {
  const usable = "reason" in layout ? null : layout;
  const environment =
    facts ??
    (usable === null
      ? invalidEnvironmentFacts(request.workspacePath, request.environment)
      : derivedFacts(request, usable));
  return {
    kind: "rebuild",
    status,
    environment,
    run: run ?? noRunFacts,
    failure: { stage, message: redact(reason), exitCode: null },
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}

function redact(message: string): string {
  return createDiagnosticRedactor([])(message);
}

/** 载荷无法核验时没有可信请求，按请求阶段交出结果。 */
export function rebuildInvalidPayload(message: string): RebuildOperationResult {
  return {
    kind: "rebuild",
    status: "invalid-request",
    environment: invalidEnvironmentFacts(process.cwd(), "<invalid>"),
    run: noRunFacts,
    failure: { stage: "request", message: redact(message), exitCode: null },
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}

/**
 * 操作内部没有形成结果时的如实上报：重建意图可能已落盘，保留记录与现场，
 * 让下一次显式 rebuild 按同一意图继续。
 */
export async function rebuildCrashResult(
  request: RebuildRequest,
  error: unknown,
  held: HeldCommands,
): Promise<RebuildOperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  const cleanup = await held.close();
  const message = redact(`重建操作异常：${describeError(error)}`);
  return {
    kind: "rebuild",
    status: "not-confirmed",
    environment:
      "reason" in layout
        ? invalidEnvironmentFacts(request.workspacePath, request.environment)
        : derivedFacts(request, layout),
    run: { ...noRunFacts, lastFailure: { stage: "operation", message } },
    failure: { stage: "operation", message, exitCode: null },
    cleanup,
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}
