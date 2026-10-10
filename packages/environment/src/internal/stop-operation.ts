import { mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";

import type { OperationCancellation } from "./cancellation.ts";
import {
  invalidEnvironmentFacts,
  noRunFacts,
  recordedRunFacts,
  validateStartOrStopRequest,
  type EnvironmentFacts,
  type ProcessLiveness,
  type StopFailureStage,
  type StopOperationResult,
  type StopRequest,
} from "./operation-contract.ts";
import {
  describeError,
  derivedFacts,
  directoryIdentity,
  environmentFacts,
  finishOperation,
  listFiles,
  note,
  releaseRunSecrets,
  saveRecord,
  withOperation,
} from "./operation-support.ts";
import {
  createLayout,
  createOperationId,
  type EnvironmentLayout,
} from "./paths.ts";
import { requestPrivateControl } from "./private-control.ts";
import { sameProcessIdentity } from "./process-identity.ts";
import {
  readRecord,
  recordedLogHealthValues,
  type EnvironmentRecord,
  type EnvironmentRunRecord,
  type RecordedLogHealth,
} from "./record.ts";
import { createDiagnosticRedactor } from "./redact.ts";
import { observeLiveness, verifyRunTarget } from "./run-observation.ts";
import { readTerminalFacts } from "./terminal-facts.ts";

/**
 * 停止只做两件事：经本世代私有控制通道请求一次自终止，然后有界确认进程真实退出。
 * 宽限取产品自身的 30 秒默认值再加余量——环境不会把相关环境变量传给产品，产品
 * 必然使用该默认值。
 */
const shutdownGraceMilliseconds = 30_000;
const graceMarginMilliseconds = 10_000;
const controlTimeoutMilliseconds = 5_000;
const exitPollMilliseconds = 200;
const logTailBytes = 16_384;

type StopOperation = {
  readonly operationId: string;
  readonly startedAt: string;
  readonly logDirectory: string;
  readonly operationLog: string;
  readonly logErrors: string[];
  logCreated: boolean;
};

/**
 * 在持有同一环境锁的进程内停止该记录自己管理的服务：核验私有现场归属后请求一次
 * 自终止，确认退出才提交已停止事实；无法确认就保留停止中事实、秘密与现场，交给
 * 后续停止命令，绝不按 PID 或端口猜测发信号，也绝不删除产品数据、配置或日志。
 *
 * 取消只中止本次观察：取消成立时不再发出新的停止请求，也不再宣称已停止，而是保留
 * 停止中事实与私有现场，交回精确指针让后续停止命令按原有宽限确认。已经观察到的
 * 退出事实不会因为取消而被撤回。
 */
export async function runStopOperation(
  request: StopRequest,
  cancellation: OperationCancellation,
): Promise<StopOperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  if ("reason" in layout)
    return outerResult(request, "invalid-request", "request", layout.reason);
  const validation = validateStartOrStopRequest(request);
  if (validation !== undefined)
    return outerResult(
      request,
      "invalid-request",
      "request",
      validation.reason,
    );

  const read = await readRecord(layout.recordPath);
  if (read.kind === "corrupt")
    return outerResult(
      request,
      "unmanaged",
      "claim",
      `环境记录损坏或版本未知，保留原件不接管：${read.reason}`,
      layout,
    );
  if (read.kind === "absent") {
    if (await containerHasContent(layout.containerDirectory))
      return outerResult(
        request,
        "unmanaged",
        "claim",
        "存在无记录的同名非空容器，不受本记录管理，无法据此停止",
        layout,
      );
    return outerResult(
      request,
      "already-stopped",
      "claim",
      "该环境没有准备记录，尚无被该记录管理的服务",
      layout,
    );
  }

  const record = read.record;
  const container = await directoryIdentity(layout.containerDirectory);
  if (
    container === undefined ||
    record.workspacePath !== layout.workspacePath ||
    record.environment !== layout.environment ||
    record.containerIdentity.device !== container.device ||
    record.containerIdentity.inode !== container.inode
  )
    return outerResult(
      request,
      "unmanaged",
      "claim",
      "环境记录与当前容器身份不一致，拒绝接管",
      layout,
      environmentFacts(record, layout),
      recordedRunFacts(record),
    );

  const facts = environmentFacts(record, layout);
  const run = record.run;
  if (run === undefined)
    return await withoutManagedRun(
      record,
      layout,
      facts,
      "该环境记录没有受管理的运行分支，没有需要停止的服务",
    );
  if (run.state === "stopped") {
    const liveness = observeLiveness(run.processIdentity);
    if (liveness !== "alive")
      return await withoutManagedRun(
        record,
        layout,
        facts,
        `本记录管理的世代 ${run.runId} 已确认停止`,
      );
    return {
      kind: "stop",
      status: "not-confirmed",
      environment: facts,
      run: { ...recordedRunFacts(record), processLiveness: liveness },
      failure: {
        stage: "generation",
        message: redact(
          "记录已标记为已停止但进程身份仍显示存活，不按 PID 或端口发信号，也不重复请求关闭",
        ),
        exitCode: null,
      },
      cleanup: { state: "unknown", errors: [] },
      logs: { directory: null, files: [] },
      diagnostics: [],
    };
  }
  return await stopManagedGeneration(record, layout, facts, run, cancellation);
}

/** 记录里没有受管理世代时的可重复停止：只追加本次历史，不改动运行分支。 */
async function withoutManagedRun(
  record: EnvironmentRecord,
  layout: EnvironmentLayout,
  facts: EnvironmentFacts,
  reason: string,
): Promise<StopOperationResult> {
  const operation = createStopOperation(layout);
  await openStopLogDirectory(operation);
  await logStop(operation, `stop ${layout.environment}：${reason}`);
  const saved = await saveRecord(
    layout.recordPath,
    withOperation(record, stopEntry(operation), "already-stopped"),
  );
  if (saved !== undefined) operation.logErrors.push(saved);
  return {
    kind: "stop",
    status: "already-stopped",
    environment: facts,
    run: recordedRunFacts(record),
    cleanup: { state: "not-started", errors: [] },
    logs: await stopLogs(operation),
    diagnostics: [...operation.logErrors],
  };
}

/**
 * 受管理世代的停止：只有私有现场可核验才请求关闭；确认退出才提交已停止事实并释放
 * 秘密，无法确认时保留停止中事实与现场。
 */
async function stopManagedGeneration(
  record: EnvironmentRecord,
  layout: EnvironmentLayout,
  facts: EnvironmentFacts,
  run: EnvironmentRunRecord,
  cancellation: OperationCancellation,
): Promise<StopOperationResult> {
  if (cancellation.triggered())
    return unconfirmed(
      facts,
      record,
      "control",
      `${cancellation.reason()}：取消在发出停止请求之前成立，记录与本世代都原样保留，可再次发出停止`,
      observeLiveness(run.processIdentity),
    );
  const target = await verifyRunTarget(record);
  if ("reason" in target) {
    if (target.liveness === "exited")
      return await commitStopped(
        record,
        layout,
        facts,
        run,
        createStopOperation(layout),
        `私有现场无法核验（${target.reason}），但进程身份确认已退出，按退出事实收尾`,
      );
    return unconfirmed(
      facts,
      record,
      "control",
      `无法确认既有世代的私有现场归属，也没有确认可它的进程已退出，因此不发信号也不接管：${target.reason}`,
      target.liveness,
    );
  }

  const operation = createStopOperation(layout);
  await openStopLogDirectory(operation);
  // 记录写入失败会让已经观察到的身份与终结事实没能落盘；它们留在刚刚按目录身份与
  // 启动配置核验过归属的同一私有现场里。取回后，退出确认与收尾都沿用原有路径。
  const recovered = await recoverRunFacts(record, run);
  const generation = recovered.run;
  if (recovered.note !== undefined) {
    operation.logErrors.push(recovered.note);
    await logStop(operation, recovered.note);
  }
  const stopping: EnvironmentRecord = {
    ...record,
    operations: [...record.operations, stopEntry(operation)],
    run: { ...generation, state: "stopping", updatedAt: operation.startedAt },
  };
  await logStop(
    operation,
    `stop ${layout.environment}：请求世代 ${run.runId} 经私有控制通道自行关闭（操作 ${operation.operationId}）`,
  );
  const intentProblem = await saveRecord(layout.recordPath, stopping);
  if (intentProblem !== undefined)
    return unconfirmed(
      facts,
      record,
      "operation",
      `停止意图无法写入记录，因此没有发出停止请求：${intentProblem}`,
      observeLiveness(generation.processIdentity),
      operation,
    );

  const control = await requestPrivateControl({
    socketPath: generation.controlSocket,
    environmentId: record.environmentId,
    runId: generation.runId,
    controlKey: target.target.controlKey,
    kind: "stop",
    timeoutMilliseconds: controlTimeoutMilliseconds,
  });
  if ("reason" in control) {
    const liveness = observeLiveness(generation.processIdentity);
    if (liveness === "exited")
      return await commitStopped(
        record,
        layout,
        facts,
        generation,
        operation,
        `控制通道没有响应（${control.reason}），但进程身份确认已退出`,
      );
    return await keepUnconfirmed(
      stopping,
      layout,
      facts,
      generation,
      operation,
      `停止请求未能经私有控制通道成立，且无法确认进程已退出：${control.reason}`,
    );
  }
  await logStop(
    operation,
    control.reply.already === true
      ? "本世代已在关闭过程中，只观察同一次关闭"
      : "本世代已接受关闭请求，退出码与信号由产品自身收尾决定，外部不可观察",
  );

  const awaitedExit = await cancellation.watch(awaitExit(generation));
  if (awaitedExit.cancelled)
    return await keepUnconfirmed(
      stopping,
      layout,
      facts,
      generation,
      operation,
      `${cancellation.reason()}：取消只中止本次退出观察，停止请求的应答见本次操作日志；停止中事实与私有现场都保留给后续停止命令确认退出`,
    );
  const liveness = awaitedExit.value;
  if (liveness !== "exited")
    return await keepUnconfirmed(
      stopping,
      layout,
      facts,
      generation,
      operation,
      `已请求一次自终止，但在 ${String(
        shutdownGraceMilliseconds + graceMarginMilliseconds,
      )} 毫秒内无法确认世代 ${run.runId} 退出（进程 ${liveness}）`,
    );
  return await commitStopped(
    record,
    layout,
    facts,
    generation,
    operation,
    `世代 ${run.runId} 已确认退出`,
    await finalLogHealth(generation.productLogFile),
  );
}

/**
 * 按已核验归属的私有现场取回记录没能落下的进程身份、终结事实与失败首因。记录可能
 * 只写成功了一部分：身份已经保存、随后更大的终结记录因同一文件系统限制失败，因此
 * 即便记录已有身份也要读现场，并且只在现场指向同一个进程身份时才补齐记录尚缺的事实。
 * 现场没有留存、内容不可核验、世代或身份不符时一律原样返回，不凭其它迹象推断进程状态。
 */
async function recoverRunFacts(
  record: EnvironmentRecord,
  run: EnvironmentRunRecord,
): Promise<{
  readonly run: EnvironmentRunRecord;
  readonly note?: string;
}> {
  const read = await readTerminalFacts(run.privateDirectory);
  if ("absent" in read) return { run };
  if ("reason" in read)
    return {
      run,
      note: `本世代私有现场的终结事实不可核验，按未知保留现场：${read.reason}`,
    };
  const facts = read.facts;
  if (facts.environmentId !== record.environmentId || facts.runId !== run.runId)
    return {
      run,
      note: "本世代私有现场的终结事实与记录的环境或世代标识不符，不使用",
    };
  if (
    run.processIdentity !== undefined &&
    !sameProcessIdentity(run.processIdentity, facts.processIdentity)
  )
    return {
      run,
      note: "本世代私有现场的终结事实指向另一个进程身份，与记录已有身份不是同一个进程，不使用",
    };
  const recoverIdentity = run.processIdentity === undefined;
  const recoverEnded = run.ended === undefined && facts.ended !== undefined;
  const recoverFailure = run.lastFailure === undefined;
  if (!(recoverIdentity || recoverEnded || recoverFailure)) return { run };
  const missing = [
    ...(recoverIdentity ? ["进程身份"] : []),
    ...(recoverEnded ? ["终结事实"] : []),
    ...(recoverFailure ? ["失败首因"] : []),
  ].join("、");
  return {
    run: {
      ...run,
      ...(recoverIdentity ? { processIdentity: facts.processIdentity } : {}),
      ...(recoverEnded ? { ended: facts.ended } : {}),
      ...(recoverFailure ? { lastFailure: facts.lastFailure } : {}),
    },
    note: `按已核验归属的本世代私有现场，取回记录未能写入的${missing}（原始失败 ${
      facts.lastFailure.stage
    }：${facts.lastFailure.message}）`,
  };
}

/**
 * 已停止事实的提交：退出时刻可确认，退出码与信号由产品自行决定而外部不可观察；
 * 被打断的启动历史补记为 interrupted，只有记录确实写入成功才释放本世代秘密。
 */
async function commitStopped(
  record: EnvironmentRecord,
  layout: EnvironmentLayout,
  facts: EnvironmentFacts,
  run: EnvironmentRunRecord,
  operation: StopOperation,
  reason: string,
  health?: RecordedLogHealth,
): Promise<StopOperationResult> {
  const at = new Date().toISOString();
  const committed = interruptStart(
    finishOperation(
      {
        ...record,
        run: {
          ...run,
          state: "stopped",
          updatedAt: at,
          logHealth: health ?? run.logHealth ?? "unknown",
          // 外部通常观察不到退出码与信号；本世代由父操作亲自启动并观察到真实结束时，
          // 保留那份事实，不用占位值覆盖。
          ended: run.ended ?? { at, code: null, signal: null },
        },
      },
      operation.operationId,
      "stopped",
    ),
    run.startOperationId,
  );
  await openStopLogDirectory(operation);
  await logStop(
    operation,
    `${reason}${
      health === undefined
        ? "（运行日志没有交出可识别的收尾健康标记，保留记录中的日志健康）"
        : `（日志健康 ${health}）`
    }`,
  );
  const saved = await saveRecord(layout.recordPath, committed);
  if (saved !== undefined) {
    operation.logErrors.push(saved);
    return {
      kind: "stop",
      status: "not-confirmed",
      environment: facts,
      run: {
        ...recordedRunFacts(record),
        processLiveness: "exited",
        lastFailure: { stage: "operation", message: redact(saved) },
      },
      failure: {
        stage: "operation",
        message: redact(saved),
        exitCode: null,
      },
      cleanup: {
        state: "stopped",
        errors: [
          "进程已确认退出，但已停止事实未能写入记录，因此保留本世代秘密与现场",
        ],
      },
      logs: await stopLogs(operation),
      diagnostics: [...operation.logErrors],
    };
  }
  const problems = await releaseRunSecrets(run);
  return {
    kind: "stop",
    status: "stopped",
    environment: facts,
    run: {
      ...recordedRunFacts(committed),
      processLiveness: "exited",
      controlReachable: false,
      serviceReady: false,
    },
    cleanup: { state: "stopped", errors: [...problems] },
    logs: await stopLogs(operation),
    diagnostics: [...operation.logErrors],
  };
}

/** 无法确认退出：保留停止中事实、秘密与现场，让后续停止仍可认证重试。 */
async function keepUnconfirmed(
  stopping: EnvironmentRecord,
  layout: EnvironmentLayout,
  facts: EnvironmentFacts,
  run: EnvironmentRunRecord,
  operation: StopOperation,
  reason: string,
): Promise<StopOperationResult> {
  const message = redact(reason);
  const kept: EnvironmentRecord = {
    ...stopping,
    run: {
      ...run,
      state: "stopping",
      updatedAt: new Date().toISOString(),
      lastFailure: { stage: "control", message },
    },
  };
  await logStop(
    operation,
    `停止未能确认：${message}；保留停止中事实与私有现场以便后续停止`,
  );
  const saved = await saveRecord(
    layout.recordPath,
    finishOperation(kept, operation.operationId, "not-confirmed"),
  );
  if (saved !== undefined) operation.logErrors.push(saved);
  return {
    kind: "stop",
    status: "not-confirmed",
    environment: facts,
    run: {
      ...recordedRunFacts(kept),
      processLiveness: observeLiveness(run.processIdentity),
      lastFailure: { stage: "control", message },
    },
    failure: { stage: "control", message, exitCode: null },
    cleanup: {
      state: "unknown",
      errors: ["未能确认本世代退出，已保留私有运行现场与秘密以便再次停止"],
    },
    logs: await stopLogs(operation),
    diagnostics: [...operation.logErrors],
  };
}

/** 没有发出停止请求的不可确认结果：记录原样保留，不谎报日志位置。 */
function unconfirmed(
  facts: EnvironmentFacts,
  record: EnvironmentRecord,
  stage: StopFailureStage,
  reason: string,
  liveness: ProcessLiveness,
  operation?: StopOperation,
): StopOperationResult {
  const message = redact(reason);
  return {
    kind: "stop",
    status: "not-confirmed",
    environment: facts,
    run: {
      ...recordedRunFacts(record),
      processLiveness: liveness,
      lastFailure: { stage, message },
    },
    failure: { stage, message, exitCode: null },
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [...(operation?.logErrors ?? [])],
  };
}

/** 记录之外的结果：不改动任何环境自有内容，也不宣称服务归属。 */
function outerResult(
  request: StopRequest,
  status: "unmanaged" | "invalid-request" | "already-stopped",
  stage: "request" | "claim",
  reason: string,
  layout?: EnvironmentLayout,
  facts?: EnvironmentFacts,
  run?: ReturnType<typeof recordedRunFacts>,
): StopOperationResult {
  const environment =
    facts ??
    (layout === undefined
      ? invalidEnvironmentFacts(request.workspacePath, request.environment)
      : derivedFacts(request, layout));
  // 已停止是与实际一致的结论，不是失败，因此不编造失败说明。
  const failure =
    status === "already-stopped"
      ? {}
      : { failure: { stage, message: redact(reason), exitCode: null } };
  return {
    kind: "stop",
    status,
    environment,
    run: run ?? noRunFacts,
    ...failure,
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}

function stopEntry(
  operation: StopOperation,
): EnvironmentRecord["operations"][number] {
  return {
    id: operation.operationId,
    kind: "stop",
    startedAt: operation.startedAt,
    logDirectory: path.posix.join("logs", operation.operationId),
  };
}

function createStopOperation(layout: EnvironmentLayout): StopOperation {
  const startedAt = new Date().toISOString();
  const operationId = createOperationId(new Date());
  const logDirectory = path.join(layout.logsRoot, operationId);
  return {
    operationId,
    startedAt,
    logDirectory,
    operationLog: path.join(logDirectory, "operation.log"),
    logErrors: [],
    logCreated: false,
  };
}

async function openStopLogDirectory(operation: StopOperation): Promise<void> {
  if (operation.logCreated) return;
  try {
    await mkdir(operation.logDirectory, { recursive: true, mode: 0o700 });
    operation.logCreated = true;
  } catch (error) {
    operation.logErrors.push(
      `停止操作日志目录无法建立：${describeError(error)}`,
    );
  }
}

async function logStop(
  operation: StopOperation,
  message: string,
): Promise<void> {
  if (!operation.logCreated) return;
  await note(operation.operationLog, operation.logErrors, message);
}

async function stopLogs(
  operation: StopOperation,
): Promise<StopOperationResult["logs"]> {
  if (!operation.logCreated) return { directory: null, files: [] };
  return {
    directory: operation.logDirectory,
    files: await listFiles(operation.logDirectory, operation.logErrors),
  };
}

/** 只按产品默认宽限加余量有界等待；确认退出的唯一依据是进程身份消失。 */
async function awaitExit(run: EnvironmentRunRecord): Promise<ProcessLiveness> {
  const deadline =
    Date.now() + shutdownGraceMilliseconds + graceMarginMilliseconds;
  for (;;) {
    const liveness = observeLiveness(run.processIdentity);
    if (liveness !== "alive") return liveness;
    if (Date.now() >= deadline) return liveness;
    await new Promise((resolve) => setTimeout(resolve, exitPollMilliseconds));
  }
}

/**
 * 已退出后从运行日志尾部读取产品自己写下的收尾健康；读不到不猜测，也不覆盖记录中
 * 已知的健康事实。
 */
async function finalLogHealth(
  productLogFile: string,
): Promise<RecordedLogHealth | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(productLogFile, "r");
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - logTailBytes);
    const buffer = Buffer.alloc(stat.size - start);
    if (buffer.length === 0) return undefined;
    await handle.read(buffer, 0, buffer.length, start);
    let last: string | undefined;
    for (const match of buffer.toString("utf8").matchAll(/health=([a-z]+)/gu))
      last = match[1];
    return last !== undefined && recordedLogHealthValues.includes(last as never)
      ? (last as RecordedLogHealth)
      : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 世代在启动过程中被停止时，未完成的启动历史如实记为被打断。 */
function interruptStart(
  record: EnvironmentRecord,
  startOperationId: string,
): EnvironmentRecord {
  return {
    ...record,
    operations: record.operations.map((operation) =>
      operation.id === startOperationId &&
      operation.outcome === undefined &&
      operation.finishedAt === undefined
        ? {
            ...operation,
            finishedAt: new Date().toISOString(),
            outcome: "interrupted" as const,
          }
        : operation,
    ),
  };
}

async function containerHasContent(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length > 0;
  } catch {
    return false;
  }
}

function redact(message: string): string {
  return createDiagnosticRedactor([])(message);
}

/** 载荷无法核验时没有可信请求，只能按请求阶段交出结果。 */
export function stopInvalidPayload(message: string): StopOperationResult {
  return outerResult(
    { kind: "stop", workspacePath: process.cwd(), environment: "<invalid>" },
    "invalid-request",
    "request",
    message,
  );
}

/** 操作内部没有形成结果时的如实上报：没有确认退出，就保留一切交由后续停止。 */
export function stopCrashResult(
  request: StopRequest,
  error: unknown,
): StopOperationResult {
  const message = redact(`停止操作异常：${describeError(error)}`);
  return {
    kind: "stop",
    status: "not-confirmed",
    environment: invalidEnvironmentFacts(
      request.workspacePath,
      request.environment,
    ),
    run: { ...noRunFacts, lastFailure: { stage: "operation", message } },
    failure: { stage: "operation", message, exitCode: null },
    cleanup: {
      state: "unknown",
      errors: ["停止操作未能完成，无法确认受管理服务的状态"],
    },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}
