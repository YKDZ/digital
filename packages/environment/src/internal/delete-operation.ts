import { lstat, mkdir, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { privateRunScopeName } from "./launch-contract.ts";
import {
  invalidEnvironmentFacts,
  noRunFacts,
  recordedRunFacts,
  type DeleteFailureStage,
  type DeleteOperationResult,
  type DeleteRequest,
  type EnvironmentFacts,
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
  verifyLogsOwnership,
  type EnvironmentLayout,
} from "./paths.ts";
import type { HeldCommands } from "./processes.ts";
import { assertProductRootOffline } from "./product-offline.ts";
import {
  readRecord,
  type DestructiveIntent,
  type EnvironmentRecord,
  type EnvironmentRunRecord,
} from "./record.ts";
import { createDiagnosticRedactor } from "./redact.ts";
import { observeLiveness } from "./run-observation.ts";

/** 私有运行目录的规范前缀：只回收位于系统临时区自有命名空间之下的目录。 */
const privateRunRoot = path.join(tmpdir(), "digital-environments");

/**
 * 删除已停止且归属完整的自有环境：离线核验通过后先持久删除意图，再按私有运行
 * 现场、日志、产品数据、记录本身的顺序逐项回收——每项都重新核验规范路径与目录
 * 身份，任何变化都不删除。所有自有资源确认删除后才移除环境记录；重复删除返回
 * 明确的已删除。绝不触碰输入素材、其他环境或工作区管理级锁文件。
 */
export async function runDeleteOperation(
  request: DeleteRequest,
  held: HeldCommands,
): Promise<DeleteOperationResult> {
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
  if (read.kind === "absent") return await deleteWithoutRecord(request, layout);

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
  const blocked = deleteBlockedByRun(record);
  if (blocked !== undefined)
    return outerFailure(
      request,
      layout,
      "refused",
      "generation",
      blocked,
      facts,
      recordedRunFacts(record),
    );
  // 日志根被预先重定向到素材或其他环境时，第一个操作日志就会越界写入：必须在
  // 建立任何日志目录之前拒绝，并把两侧内容原样留下。
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
      `删除操作日志目录无法建立：${describeError(error)}`,
      facts,
      recordedRunFacts(record),
    );
  }
  await note(
    operationLog,
    logErrors,
    `delete ${layout.environment} 开始（操作 ${operationId}，数据世代 ${record.dataGeneration}）`,
  );

  // 意图落盘之前只做无副作用的离线核验：出现管理器之外的使用迹象就原样保留记录。
  const offline = await assertProductRootOffline({
    layout,
    inputs: record.inputs,
    // 只有本管理器已经写下破坏意图的重入才可能是自己的部分回收残余。
    continuationEligible: record.destructive !== undefined,
    logFile: path.join(logDirectory, "offline-check.log"),
    held,
  });
  if ("reason" in offline) {
    await note(
      operationLog,
      logErrors,
      `删除被拒绝（未改动任何内容）：${offline.reason}`,
    );
    return {
      kind: "delete",
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
    await note(
      operationLog,
      logErrors,
      "上次回收已把自有数据根删成残余（正式备份判定副本源不完整、维护准入已通过）；本次删除继续收回残余",
    );

  const intent: DestructiveIntent = {
    kind: "delete",
    operationId,
    startedAt: new Date().toISOString(),
    targetDataGeneration: record.dataGeneration,
    targetRunId: record.run?.runId ?? null,
  };
  const intentRecord: EnvironmentRecord = {
    ...record,
    destructive: intent,
    preparation: {
      ...record.preparation,
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
        kind: "delete" as const,
        startedAt: intent.startedAt,
        logDirectory: path.posix.join("logs", operationId),
      },
    ],
  };
  const intentProblem = await saveRecord(layout.recordPath, intentRecord);
  if (intentProblem !== undefined) {
    await note(
      operationLog,
      logErrors,
      `删除意图无法写入记录，未做任何破坏性改动：${intentProblem}`,
    );
    return {
      kind: "delete",
      status: "failed",
      environment: facts,
      run: recordedRunFacts(record),
      failure: {
        stage: "intent",
        message: redact(`写入删除意图失败：${intentProblem}`),
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
  await note(operationLog, logErrors, "删除意图已持久；开始逐项回收自有资源");

  const problems = await purgeOwnedResources(layout, intentRecord, logErrors);
  if (problems !== undefined) {
    await note(operationLog, logErrors, `删除未完成：${problems.message}`);
    const cleanup = await held.close();
    return {
      kind: "delete",
      status: "not-confirmed",
      environment: facts,
      run: recordedRunFacts(intentRecord),
      failure: {
        stage: problems.stage,
        message: redact(problems.message),
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

  // 自有资源全部确认删除后才移除记录；记录之后容器只允许为空或不存在。
  const recordRemoval = await removeFile(layout.recordPath, "环境记录");
  if (recordRemoval !== undefined) {
    await note(operationLog, logErrors, recordRemoval);
    const cleanup = await held.close();
    return {
      kind: "delete",
      status: "not-confirmed",
      environment: facts,
      run: recordedRunFacts(intentRecord),
      failure: {
        stage: "purge",
        message: redact(recordRemoval),
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
  const diagnostics = [...logErrors];
  const containerRemoval = await rmdir(layout.containerDirectory).catch(
    (error: unknown) => {
      const code =
        error instanceof Error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") return undefined;
      if (code === "ENOTEMPTY")
        return `容器目录仍有无法归属本环境的残余内容，未删除：${layout.containerDirectory}`;
      return `容器目录未能移除：${layout.containerDirectory}（${describeError(error)}）`;
    },
  );
  if (containerRemoval !== undefined) diagnostics.push(containerRemoval);
  // 删除把该环境日志一并收回，收尾结论只能走公开结果的诊断：此处不再写已不存在的日志文件，
  // 免得成功的删除自报一条写入失败。
  diagnostics.push(
    "该环境自有记录、日志、数据与私有运行现场已全部回收（操作日志随删除一并回收）",
  );
  const cleanup = await held.close();
  return {
    kind: "delete",
    status: "deleted",
    environment: facts,
    run: recordedRunFacts(intentRecord),
    cleanup,
    // 日志随删除一并回收，成功结果不留下已不存在的指针。
    logs: { directory: null, files: [] },
    diagnostics,
  };
}

/**
 * 无记录的容器：不存在就是已删除；空容器是本管理器可能留下过的可辨认残余，非递归
 * 移除它；非空容器不是归属证据，一律拒绝认领，不递归清理任何无记录内容。
 */
async function deleteWithoutRecord(
  request: DeleteRequest,
  layout: EnvironmentLayout,
): Promise<DeleteOperationResult> {
  const outcome = (
    status: "already-deleted" | "unmanaged",
    reason?: string,
  ): DeleteOperationResult => ({
    kind: "delete",
    status,
    environment: derivedFacts(request, layout),
    run: noRunFacts,
    ...(reason === undefined
      ? {}
      : {
          failure: {
            stage: "claim" as const,
            message: redact(reason),
            exitCode: null,
          },
        }),
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  });
  let entries: string[];
  try {
    entries = await readdir(layout.containerDirectory);
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return outcome("already-deleted");
    return outcome(
      "unmanaged",
      `容器目录无法核验，不能确认已删除：${layout.containerDirectory}（${describeError(error)}）`,
    );
  }
  if (entries.length > 0)
    return outcome(
      "unmanaged",
      `存在无记录的同名非空容器，不受本记录管理，拒绝认领且不递归清理：${layout.containerDirectory}`,
    );
  // 空容器：移除失败不影响“没有受管理内容”这一已删除结论，只作为诊断。
  const diagnostics: string[] = [];
  const removal = await rmdir(layout.containerDirectory).catch(
    (error: unknown) => {
      const code =
        error instanceof Error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      return code === "ENOENT"
        ? undefined
        : `空容器目录未能移除：${layout.containerDirectory}（${describeError(error)}）`;
    },
  );
  if (removal !== undefined) diagnostics.push(removal);
  return {
    kind: "delete",
    status: "already-deleted",
    environment: derivedFacts(request, layout),
    run: noRunFacts,
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics,
  };
}

/**
 * 按固定顺序回收自有资源，任何一处归属或身份核验不过就整体停止并保留记录与意图，
 * 让下一次 delete 按原意图继续同一目标。
 */
async function purgeOwnedResources(
  layout: EnvironmentLayout,
  record: EnvironmentRecord,
  diagnostics: string[],
): Promise<{ stage: DeleteFailureStage; message: string } | undefined> {
  if (record.run !== undefined) {
    const problem = await purgePrivateRun(record.run, record);
    if (problem !== undefined) return { stage: "purge", message: problem };
  }
  const logs = await purgeOwnedDirectory(
    layout.logsRoot,
    layout.containerDirectory,
    "日志目录",
    [],
  );
  if (logs !== undefined) return { stage: "purge", message: logs };
  const data = await purgeOwnedDirectory(
    layout.productDataRoot,
    layout.containerDirectory,
    "产品数据根",
    record.inputs,
  );
  if (data !== undefined) return { stage: "purge", message: data };
  diagnostics.push(
    "私有运行现场、日志目录与产品数据根已确认回收，开始移除环境记录",
  );
  return undefined;
}

async function purgeOwnedDirectory(
  directory: string,
  containerDirectory: string,
  label: string,
  inputs: readonly string[],
): Promise<string | undefined> {
  if (!directory.startsWith(`${containerDirectory}${path.sep}`))
    return `${label}不在容器之内，拒绝回收：${directory}`;
  let existing: Awaited<ReturnType<typeof lstat>>;
  try {
    existing = await lstat(directory);
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return undefined;
    return `${label}无法核验，未回收：${directory}（${describeError(error)}）`;
  }
  if (!existing.isDirectory())
    return `${label}不是环境自有目录，归属已变化，未回收：${directory}`;
  let resolved: string;
  try {
    resolved = await realpath(directory);
  } catch (error) {
    return `${label}无法解析，未回收：${directory}（${describeError(error)}）`;
  }
  if (resolved !== directory)
    return `${label}已指向所选环境之外的位置，未回收：${directory} → ${resolved}`;
  for (const input of inputs)
    if (overlaps(resolved, input))
      return `${label}与输入素材重叠，未回收：${resolved} ↔ ${input}`;
  try {
    await rm(directory, { recursive: true });
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return undefined;
    return `${label}回收失败，保留现场：${directory}（${describeError(error)}）`;
  }
  try {
    await lstat(directory);
    return `${label}回收后仍然存在，结果未确认：${directory}`;
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    return code === "ENOENT"
      ? undefined
      : `${label}回收后无法核验其不存在：${directory}（${describeError(error)}）`;
  }
}

/**
 * 私有运行目录只按记录里的规范路径与 dev/ino 身份认领：目录内容在停止后可能已
 * 释放了秘密但保留了产品日志，删除整个已核验世代目录属于本环境自有资源回收。
 * 停止保留世代日志用于诊断，删除才把该环境命名空间内的每个世代一并收回。
 */
async function purgePrivateRun(
  run: EnvironmentRunRecord,
  record: EnvironmentRecord,
): Promise<string | undefined> {
  const directory = run.privateDirectory;
  if (!directory.startsWith(`${privateRunRoot}${path.sep}`))
    return `私有运行目录不在本管理器命名空间内，拒绝回收：${directory}`;
  const scopeDirectory = path.dirname(directory);
  if (
    scopeDirectory !==
    path.join(
      privateRunRoot,
      privateRunScopeName(record.workspacePath, record.environmentId),
    )
  )
    return `私有运行命名空间与记录身份不符，拒绝回收：${scopeDirectory}`;
  const generation = await purgeRecordedGeneration(directory, run);
  if (generation !== undefined) return generation;
  return await purgePrivateRunNamespace(scopeDirectory);
}

async function purgeRecordedGeneration(
  directory: string,
  run: EnvironmentRunRecord,
): Promise<string | undefined> {
  let existing: Awaited<ReturnType<typeof lstat>>;
  try {
    existing = await lstat(directory);
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return undefined;
    return `私有运行目录无法核验，未回收：${directory}（${describeError(error)}）`;
  }
  if (!existing.isDirectory())
    return `私有运行目录不是目录，归属已变化，未回收：${directory}`;
  let resolved: string;
  try {
    resolved = await realpath(directory);
  } catch (error) {
    return `私有运行目录无法解析，未回收：${directory}（${describeError(error)}）`;
  }
  if (resolved !== directory)
    return `私有运行目录已被重定向，未回收：${directory} → ${resolved}`;
  if (
    existing.dev !== run.privateDirectoryIdentity.device ||
    existing.ino !== run.privateDirectoryIdentity.inode
  )
    return `私有运行目录身份与记录不一致，未回收：${directory}`;
  try {
    await rm(directory, { recursive: true });
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return undefined;
    return `私有运行目录回收失败，保留现场：${directory}（${describeError(error)}）`;
  }
  try {
    await lstat(directory);
    return `私有运行目录回收后仍然存在，结果未确认：${directory}`;
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    return code === "ENOENT"
      ? undefined
      : `私有运行目录回收后无法核验其不存在：${directory}（${describeError(error)}）`;
  }
}

/**
 * 世代目录的上层是同一环境（工作区规范路径 + 环境 UUID）的命名空间目录：其中可能
 * 还有更早世代停止后留下的产品日志。逐个确认是未被重定向的真实目录后回收，最后
 * 移除空的命名空间目录；任何一处核验不过就保留现场并报告。
 */
async function purgePrivateRunNamespace(
  scopeDirectory: string,
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(scopeDirectory);
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    return code === "ENOENT"
      ? undefined
      : `私有运行命名空间无法核验，未回收：${scopeDirectory}（${describeError(error)}）`;
  }
  for (const entry of entries.toSorted()) {
    const problem = await purgeGenerationDirectory(
      path.join(scopeDirectory, entry),
    );
    if (problem !== undefined) return problem;
  }
  const removed = await rmdir(scopeDirectory).catch((error: unknown) => error);
  if (removed instanceof Error) {
    const code = (removed as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      return `私有运行命名空间未能移除，保留现场：${scopeDirectory}（${describeError(removed)}）`;
  }
  return undefined;
}

async function purgeGenerationDirectory(
  directory: string,
): Promise<string | undefined> {
  let existing: Awaited<ReturnType<typeof lstat>>;
  try {
    existing = await lstat(directory);
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    return code === "ENOENT"
      ? undefined
      : `私有运行世代目录无法核验，未回收：${directory}（${describeError(error)}）`;
  }
  if (!existing.isDirectory())
    return `私有运行命名空间内的内容不是世代目录，未回收：${directory}`;
  const resolved = await realpath(directory).catch(() => undefined);
  if (resolved !== directory)
    return `私有运行世代目录已被重定向，未回收：${directory}`;
  try {
    await rm(directory, { recursive: true });
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return undefined;
    return `私有运行世代目录回收失败，保留现场：${directory}（${describeError(error)}）`;
  }
  return undefined;
}

async function removeFile(
  filePath: string,
  label: string,
): Promise<string | undefined> {
  try {
    await rm(filePath, { force: true });
  } catch (error) {
    return `${label}未能移除，保留现场：${filePath}（${describeError(error)}）`;
  }
  try {
    await lstat(filePath);
    return `${label}移除后仍然存在，结果未确认：${filePath}`;
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    return code === "ENOENT"
      ? undefined
      : `${label}移除后无法核验其不存在：${filePath}（${describeError(error)}）`;
  }
}

/** 删除与重建同样拒绝在收尾未确认的世代上破坏。 */
function deleteBlockedByRun(record: EnvironmentRecord): string | undefined {
  const run = record.run;
  if (run === undefined) return undefined;
  const liveness = observeLiveness(run.processIdentity);
  if (run.state === "stopped")
    return liveness === "alive"
      ? "记录已标记为已停止但进程身份显示存活，停止结论未确认；请先用公开 stop 独立确认退出"
      : undefined;
  if (run.state === "starting" || run.state === "stopping")
    return `本环境记录显示服务正在${run.state === "starting" ? "启动" : "停止"}，删除拒绝在收尾未确认时改动环境；请先用公开 stop 独立确认退出`;
  return liveness === "exited"
    ? undefined
    : liveness === "alive"
      ? `本环境已有受记录管理的运行中服务（世代 ${run.runId}），先停止再删除`
      : `无法确认本环境受记录管理的进程是否仍在运行，删除拒绝改动环境；请先用公开 stop 独立确认`;
}

/** 意图落盘之前的结果：记录与现场都保持原样。 */
function outerFailure(
  request: DeleteRequest,
  layout: EnvironmentLayout | { readonly reason: string },
  status: "refused" | "failed" | "unmanaged" | "invalid-request",
  stage: DeleteFailureStage,
  reason: string,
  facts?: EnvironmentFacts,
  run?: ReturnType<typeof recordedRunFacts>,
): DeleteOperationResult {
  const usable = "reason" in layout ? null : layout;
  const environment =
    facts ??
    (usable === null
      ? invalidEnvironmentFacts(request.workspacePath, request.environment)
      : derivedFacts(request, usable));
  return {
    kind: "delete",
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
export function deleteInvalidPayload(message: string): DeleteOperationResult {
  return {
    kind: "delete",
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
 * 操作内部没有形成结果时的如实上报：删除意图与部分回收可能已发生，保留记录
 * 让下一次显式 delete 按原意图收敛残余。
 */
export async function deleteCrashResult(
  request: DeleteRequest,
  error: unknown,
  held: HeldCommands,
): Promise<DeleteOperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  const cleanup = await held.close();
  const message = redact(`删除操作异常：${describeError(error)}`);
  return {
    kind: "delete",
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
