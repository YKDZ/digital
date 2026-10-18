import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { OperationCancellation } from "./cancellation.ts";
import {
  invalidEnvironmentFacts,
  samePrepareInput,
  validatePrepareRequest,
  type EnvironmentFacts,
  type PrepareOperationResult,
  type PrepareRequest,
} from "./operation-contract.ts";
import {
  derivedFacts,
  describeError,
  directoryIdentity,
  environmentFacts,
  latestOperation,
  listFiles,
  note,
  saveRecord,
} from "./operation-support.ts";
import {
  createLayout,
  createOperationId,
  normalizeInputDirectories,
  verifyDataOwnership,
  serviceEntryPath,
  serviceTurboTarget,
  type EnvironmentLayout,
} from "./paths.ts";
import {
  filteredEnvironment,
  HeldCommands,
  runLoggedCommand,
  type CommandRun,
} from "./processes.ts";
import {
  readRecord,
  type EnvironmentRecord,
  type SupportedSourceMode,
} from "./record.ts";
import { createDiagnosticRedactor } from "./redact.ts";
import { observeLiveness } from "./run-observation.ts";
import { requireSourceSelectionEnvironment } from "./source-selection.ts";

const migrationEntry = path.join("packages", "db-migrations", "dist", "cli.js");

/**
 * 在持有同一环境锁的进程内执行一次完整准备：容器与记录归属、Turbo 目标构建、
 * 正式迁移、正式产品读取。只有三阶段成功且已持有子进程全部退出才记已准备。
 * 运行分支（服务归属事实）在准备中必须原样保留；活服务、启动中、停止未确认或
 * 身份未知的同世代存在时拒绝准备，绝不重建记录抹掉归属。
 *
 * 取消（期限到期或操作进程被要求终止）只中止本次执行等待：取消成立后不再启动新的
 * 阶段命令，已启动的自有子进程由一份与此无关的有界等待收尾，取消本身成为首因，
 * 收尾未能确认时作为独立错误保留。
 */
export async function runPrepareOperation(
  request: PrepareRequest,
  held: HeldCommands,
  cancellation: OperationCancellation,
): Promise<PrepareOperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  if ("reason" in layout)
    return prepareFailureResult(request, layout.reason, "request", null);
  const validation = validatePrepareRequest(request);
  if (validation !== undefined)
    return prepareFailureResult(request, validation.reason, "request", null);
  const inputs = normalizeInputDirectories(request.inputs, layout);
  if ("reason" in inputs)
    return prepareFailureResult(request, inputs.reason, "request", null);
  const effective: PrepareRequest = { ...request, inputs: inputs.inputs };

  await mkdir(layout.environmentsRoot, { recursive: true, mode: 0o700 });
  const claimed = await claimContainer(effective, layout);
  if ("result" in claimed) return claimed.result;
  const { record: prior, environmentId } = claimed;

  // 任何正式命令之前先确认实际产品数据仍属于所选环境：被预先重定向的数据根会把
  // 产品写入带到素材或其他环境之外，此时拒绝认领并原样保留两侧内容。
  const ownership = await verifyDataOwnership(layout, inputs.inputs);
  if ("reason" in ownership)
    return prepareFailureResult(request, ownership.reason, "claim", layout);

  if (prior !== undefined) {
    const busy = prepareBlockedByRun(prior);
    if (busy !== undefined)
      return prepareFailureResult(request, busy, "claim", layout);
    if (prior.destructive !== undefined)
      return prepareFailureResult(
        request,
        `该环境存在未收敛的${
          prior.destructive.kind === "rebuild" ? "重建" : "删除"
        }意图（操作 ${prior.destructive.operationId}），准备拒绝改动；请用显式 ${prior.destructive.kind} 命令继续`,
        "operation",
        layout,
      );
    const differences = samePrepareInput(effective, prior);
    if (differences.length > 0)
      return incompatibleResult(effective, layout, prior, differences);
  }

  const operationId = createOperationId(new Date());
  const logDirectory = path.join(layout.logsRoot, operationId);
  const operationLog = path.join(logDirectory, "operation.log");

  const now = new Date().toISOString();
  const interruptedOperationIds = prior
    ? prior.operations
        .filter(
          (operation) =>
            operation.id === prior.preparation.lastOperationId &&
            operation.finishedAt === undefined,
        )
        .map((operation) => operation.id)
    : [];
  const baseRecord: EnvironmentRecord = {
    version: 1,
    environmentId,
    workspacePath: layout.workspacePath,
    environment: layout.environment,
    createdAt: prior?.createdAt ?? now,
    containerIdentity: claimed.containerIdentity,
    inputs: inputs.inputs,
    sourceMode: request.sourceMode as SupportedSourceMode,
    config: request.config,
    dataGeneration: prior?.dataGeneration ?? "g1",
    // 运行分支是被本记录管理的服务归属事实，准备只更新准备状态，绝不重建它。
    ...(prior?.run === undefined ? {} : { run: prior.run }),
    preparation: {
      state: "preparing",
      updatedAt: now,
      lastOperationId: operationId,
    },
    operations: [
      ...(prior?.operations ?? []).map((operation) =>
        interruptedOperationIds.includes(operation.id) &&
        operation.finishedAt === undefined
          ? {
              ...operation,
              finishedAt: now,
              outcome: "interrupted" as const,
            }
          : operation,
      ),
      {
        id: operationId,
        kind: "prepare",
        startedAt: now,
        logDirectory: path.posix.join("logs", operationId),
      },
    ],
  };
  const intentProblem = await saveRecord(layout.recordPath, baseRecord);
  if (intentProblem !== undefined)
    return prepareFailureResult(
      request,
      `写入准备中记录失败：${intentProblem}`,
      "operation",
      layout,
    );
  const logErrors: string[] = [];
  const context: StageContext = {
    request,
    layout,
    baseRecord,
    operationLog,
    logErrors,
    interruptedOperationIds,
  };
  return await runPreparationStages(context, held, cancellation);
}

/**
 * 正式构建、正式迁移、正式产品读取三阶段与已准备提交：准备与重建共用同一
 * 权威路径，任何阶段失败都只记失败并保留首因与完整日志，不假装成功。
 * 取消条件同样共用：它只约束本次执行的等待，收尾仍是各自有界的等待。
 * `completionOutcome` 让重建把同一条操作历史直接记为已重建，避免中间态抖动。
 */
export async function runPreparationStages(
  context: StageContext,
  held: HeldCommands,
  cancellation: OperationCancellation,
  completionOutcome: "prepared" | "rebuilt" = "prepared",
): Promise<PrepareOperationResult> {
  const { layout, baseRecord, operationLog, logErrors } = context;
  const operationId = baseRecord.preparation.lastOperationId;
  const logDirectory = path.join(layout.logsRoot, operationId);
  const facts = environmentFacts(baseRecord, layout);
  /**
   * 取消成立后的收尾：命令自身的退出事实与阶段日志的持久化问题都照常保留，
   * 首因是取消本身，收尾未能确认的部分由 failStage 作为独立错误并列交出。
   */
  const cancelStage = (
    stage: "build" | "migrate" | "read",
    outcome: {
      readonly run: CommandRun | undefined;
      readonly started: boolean;
    },
  ): Promise<PrepareOperationResult> => {
    if (outcome.run !== undefined) recordLogProblems(outcome.run, logErrors);
    return failStage(context, held, {
      stage,
      message: cancellationMessage(cancellation, stage, outcome),
      exitCode: outcome.run?.exitCode ?? null,
      facts,
    });
  };
  try {
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    await note(
      operationLog,
      logErrors,
      `prepare ${layout.environment} 开始；操作 ${operationId}`,
    );
    const build = await runCancellableStage(cancellation, held, {
      command: "pnpm",
      args: [
        "exec",
        "turbo",
        "run",
        "build",
        "--filter=@digital/db-migrations",
        `--filter=${serviceTurboTarget}`,
      ],
      cwd: layout.workspacePath,
      env: filteredEnvironment(),
      logFile: path.join(logDirectory, "build.log"),
      secretValues: [],
      held,
    });
    if (build.cancelled) return await cancelStage("build", build);
    const buildRun = build.run;
    const buildLogProblem = recordLogProblems(buildRun, logErrors);
    const artifactFailure = await checkArtifacts(
      layout.workspacePath,
      buildRun.exitCode === 0 && buildRun.spawnError === undefined,
    );
    const buildProblem = stageProblem(
      buildRun,
      buildLogProblem,
      artifactFailure,
    );
    if (buildProblem !== undefined)
      return await failStage(context, held, {
        stage: "build",
        message: buildProblem,
        exitCode: buildRun.exitCode,
        facts,
      });
    await note(
      operationLog,
      logErrors,
      "阶段 build 完成（退出码 0，产物已确认）",
    );

    const productEnv = filteredEnvironment(process.env, {
      DIGITAL_PRODUCT_DATA: layout.productDataRoot,
      // 每次正式 CLI 命令都拿到与 Web 完全相同的来源装配选择。
      ...requireSourceSelectionEnvironment({
        sourceMode: context.baseRecord.sourceMode,
        config: context.baseRecord.config,
        workspacePath: layout.workspacePath,
      }),
    });
    const migrate = await runCancellableStage(cancellation, held, {
      command: process.execPath,
      args: [path.join(layout.workspacePath, migrationEntry), "prepare-only"],
      cwd: layout.workspacePath,
      env: productEnv,
      logFile: path.join(logDirectory, "migrate.log"),
      secretValues: [],
      held,
    });
    if (migrate.cancelled) return await cancelStage("migrate", migrate);
    const migrateRun = migrate.run;
    const migrateLogProblem = recordLogProblems(migrateRun, logErrors);
    const migrateCommandProblem =
      migrateRun.exitCode !== 0 ||
      migrateRun.spawnError !== undefined ||
      migrateRun.signal !== null
        ? `正式迁移命令未成功：${migrateRun.spawnError ?? `退出码 ${String(migrateRun.exitCode)} 信号 ${String(migrateRun.signal)}`}`
        : undefined;
    const migrateProblem = stageProblem(
      migrateRun,
      migrateLogProblem,
      migrateCommandProblem,
    );
    if (migrateProblem !== undefined)
      return await failStage(context, held, {
        stage: "migrate",
        message: migrateProblem,
        exitCode: migrateRun.exitCode,
        facts,
      });
    await note(operationLog, logErrors, "阶段 migrate 完成（退出码 0）");

    const read = await runCancellableStage(cancellation, held, {
      command: "pnpm",
      args: ["--filter=@digital/service", "run", "prepare:verify"],
      cwd: layout.workspacePath,
      env: productEnv,
      logFile: path.join(logDirectory, "read.log"),
      secretValues: [],
      held,
    });
    if (read.cancelled) return await cancelStage("read", read);
    const readRun = read.run;
    const readLogProblem = recordLogProblems(readRun, logErrors);
    const readCommandProblem =
      readRun.spawnError ??
      (readRun.exitCode !== 0 || readRun.signal !== null
        ? `正式产品读取命令退出码 ${String(readRun.exitCode)} 信号 ${String(readRun.signal)}`
        : undefined);
    const readProblem = stageProblem(
      readRun,
      readLogProblem,
      readCommandProblem,
    );
    if (readProblem !== undefined)
      return await failStage(context, held, {
        stage: "read",
        message: `正式产品读取未返回合法结果：${readProblem}`,
        exitCode: readRun.exitCode,
        facts,
      });
    await note(
      operationLog,
      logErrors,
      "阶段 read 完成（退出码 0，返回合法目录分页）",
    );

    /**
     * 已准备事实的提交截止点与原子写入的 rename 落在同一个不含事件循环轮次的同步块内
     * （见 writeRecordAtomic）：取消在此之前成立就不再提交，已经完成的提交也不会被
     * 返回途中的迟到取消撤销。
     */
    const commitGate = (): string | undefined =>
      cancellation.triggered()
        ? `${cancellation.reason()}：已准备事实尚未提交，取消在提交截止点之前成立`
        : undefined;
    const cleanup = await held.close();
    if (cleanup.state !== "stopped")
      return await failStage(context, held, {
        stage: "operation",
        message: "无法确认本次持有的子进程已全部退出",
        exitCode: null,
        facts,
      });

    const finishedRecord: EnvironmentRecord = {
      ...baseRecord,
      preparation: {
        state: "prepared",
        updatedAt: new Date().toISOString(),
        lastOperationId: operationId,
      },
      operations: baseRecord.operations.map((operation) =>
        operation.id === operationId
          ? {
              ...operation,
              finishedAt: new Date().toISOString(),
              outcome: completionOutcome,
            }
          : operation,
      ),
    };
    const finishedProblem = await saveRecord(
      layout.recordPath,
      finishedRecord,
      commitGate,
    );
    if (finishedProblem !== undefined) {
      if (cancellation.triggered())
        return await cancelStage("read", { run: readRun, started: true });
      return await failStage(context, held, {
        stage: "operation",
        message: `三阶段已经成功，但已准备记录无法保存：${finishedProblem}`,
        exitCode: null,
        facts,
      });
    }
    await note(operationLog, logErrors, "已准备（不代表服务就绪）");
    return {
      kind: "prepare",
      status: "prepared",
      environment: environmentFacts(finishedRecord, layout),
      interruptedOperationIds: context.interruptedOperationIds,
      cleanup: { state: "stopped", errors: cleanup.errors },
      logs: {
        directory: logDirectory,
        files: await listFiles(logDirectory, logErrors),
      },
      diagnostics: [...logErrors],
    };
  } catch (error) {
    // 普通异常（例如下一阶段日志文件无法打开）同样先收尾自有子进程，再以
    // 已知身份、可用日志指针和 failed 记录形成最终结果。
    return await failStage(context, held, {
      stage: "operation",
      message: `准备操作异常：${describeError(error)}`,
      exitCode: null,
      facts,
    });
  }
}

async function claimContainer(
  request: PrepareRequest,
  layout: EnvironmentLayout,
): Promise<
  | {
      readonly result: PrepareOperationResult;
    }
  | {
      readonly record: EnvironmentRecord | undefined;
      readonly environmentId: string;
      readonly containerIdentity: {
        readonly device: number;
        readonly inode: number;
      };
    }
> {
  let created = false;
  try {
    await mkdir(layout.containerDirectory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    )
      throw error;
  }
  const identity = await directoryIdentity(layout.containerDirectory);
  if (identity === undefined)
    return {
      result: prepareFailureResult(
        request,
        `环境容器无法核验目录身份：${layout.containerDirectory}`,
        "claim",
        layout,
      ),
    };
  if (created)
    return {
      record: undefined,
      environmentId: randomUUID(),
      containerIdentity: identity,
    };
  const read = await readRecord(layout.recordPath);
  if (read.kind === "corrupt")
    return {
      result: prepareFailureResult(
        request,
        `环境记录损坏或版本未知，保留原件不接管：${read.reason}`,
        "claim",
        layout,
      ),
    };
  if (read.kind === "record") {
    if (
      read.record.workspacePath !== layout.workspacePath ||
      read.record.environment !== layout.environment ||
      read.record.containerIdentity.device !== identity.device ||
      read.record.containerIdentity.inode !== identity.inode
    )
      return {
        result: prepareFailureResult(
          request,
          "环境记录与当前容器身份不一致，拒绝接管",
          "claim",
          layout,
        ),
      };
    return {
      record: read.record,
      environmentId: read.record.environmentId,
      containerIdentity: identity,
    };
  }
  // 无记录的同名容器：空容器可能是上次创建前中断的残余，可安全认领；
  // 非空容器不是管理器创建的归属证据，拒绝认领且不递归清理。
  const entries = await readdir(layout.containerDirectory).catch(() => [
    "<unreadable>",
  ]);
  if (entries.length > 0)
    return {
      result: prepareFailureResult(
        request,
        `存在无记录的同名非空容器，拒绝认领：${layout.containerDirectory}`,
        "claim",
        layout,
      ),
    };
  return {
    record: undefined,
    environmentId: randomUUID(),
    containerIdentity: identity,
  };
}

/**
 * 一次操作内共享的现场：请求、布局、准备中记录、操作日志路径与已发生的日志写入
 * 诊断。诊断独立累积，保证首因不被后续收尾错误掩盖。
 */
export type StageContext = {
  readonly request: PrepareRequest;
  readonly layout: EnvironmentLayout;
  readonly baseRecord: EnvironmentRecord;
  readonly operationLog: string;
  readonly logErrors: string[];
  /** 本次操作收编的被打断历史，随成功结果原样上报。 */
  readonly interruptedOperationIds: readonly string[];
};

/**
 * 阶段日志未能完整持久化：首因与其后的丢弃统计、句柄关闭错误都进入独立诊断，返回
 * 可作为本阶段首因的那个写入拒绝原因。
 */
function recordLogProblems(
  run: CommandRun,
  logErrors: string[],
): string | undefined {
  const failure = run.logFailure;
  if (failure === undefined) return undefined;
  logErrors.push(failure.cause, ...failure.problems);
  return failure.cause;
}

/**
 * 本阶段的首因：因日志无法持久化而主动收尾命令时，写入被拒绝就是首因（此时命令没有
 * 自行失败可言）；否则保留命令自身的普通失败，日志问题只作为并列诊断存在。
 */
function stageProblem(
  run: CommandRun,
  logProblem: string | undefined,
  commandProblem: string | undefined,
): string | undefined {
  if (run.logFailure?.endedByLogFailure === true) return logProblem;
  return commandProblem ?? logProblem;
}

/**
 * 取消成立之后不再启动新的阶段命令；已经启动的自有子进程由一份全新的有界等待收尾，
 * 因此取消永远不会跳过清理。收尾确认结束后才取该命令自己交出的真实退出事实。
 */
const stageCleanupMilliseconds = 20_000;
const stageExitObservationMilliseconds = 10_000;

type StageRunOutcome =
  | { readonly cancelled: false; readonly run: CommandRun }
  | {
      readonly cancelled: true;
      readonly run: CommandRun | undefined;
      /** 本次取消发生时该阶段是否已经把命令交给系统。 */
      readonly started: boolean;
    };

async function runCancellableStage(
  cancellation: OperationCancellation,
  held: HeldCommands,
  input: Parameters<typeof runLoggedCommand>[0],
): Promise<StageRunOutcome> {
  if (cancellation.triggered()) {
    await held.close(stageCleanupMilliseconds);
    return { cancelled: true, run: undefined, started: false };
  }
  const pending = runLoggedCommand({
    ...input,
    // 取消一旦成立，尚未交给系统的阶段命令就永远不再越界启动；已经在途的启动由
    // HeldCommands 的待决挂号纳入同一次收尾。
    abortBeforeSpawn: () =>
      cancellation.triggered()
        ? `${cancellation.reason()}：本阶段命令尚未交给系统，取消成立后不再启动`
        : undefined,
  });
  const watched = await cancellation.watch(pending);
  if (!watched.cancelled) return { cancelled: false, run: watched.value };
  const cleanup = await held.close(stageCleanupMilliseconds);
  if (cleanup.state !== "stopped") {
    // 无法确认退出时不等待、不伪造：该命令的后续走向只留在阶段日志里。
    pending.catch(() => undefined);
    return { cancelled: true, run: undefined, started: true };
  }
  const run = await observeExit(pending);
  return {
    cancelled: true,
    run,
    // 待决启动已收敛：命令承认没有交给系统时，如实报告「尚未启动」而不是伪造退出。
    started: run === undefined || run.neverStarted === undefined,
  };
}

function observeExit(
  pending: Promise<CommandRun>,
): Promise<CommandRun | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve(undefined),
      stageExitObservationMilliseconds,
    );
    timer.unref();
    pending.then(
      (run) => {
        clearTimeout(timer);
        resolve(run);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** 取消首因如实说明来源，并并列本次已观察到的自有子进程退出事实。 */
function cancellationMessage(
  cancellation: OperationCancellation,
  stage: "build" | "migrate" | "read",
  outcome: { readonly run: CommandRun | undefined; readonly started: boolean },
): string {
  const observed = !outcome.started
    ? `阶段 ${stage} 尚未把命令交给系统，没有本操作自有的子进程需要收尾`
    : outcome.run === undefined
      ? `阶段 ${stage} 的自有子进程未能确认退出，收尾状态见本次错误`
      : `阶段 ${stage} 的自有子进程已确认退出（退出码 ${String(
          outcome.run.exitCode,
        )} 信号 ${String(outcome.run.signal)}）`;
  return `${cancellation.reason()}；${observed}`;
}

async function failStage(
  context: StageContext,
  held: HeldCommands,
  failure: {
    stage: "build" | "migrate" | "read" | "operation";
    message: string;
    exitCode: number | null;
    facts: EnvironmentFacts;
  },
): Promise<PrepareOperationResult> {
  const { layout, baseRecord, logErrors } = context;
  const cleanup = await held.close();
  const now = new Date().toISOString();
  const operationId = baseRecord.preparation.lastOperationId;
  const failedRecord: EnvironmentRecord = {
    ...baseRecord,
    preparation: {
      state: "failed",
      updatedAt: now,
      lastOperationId: operationId,
      lastFailure: {
        stage: failure.stage,
        message: createDiagnosticRedactor([])(failure.message),
        cleanup: cleanup.state,
      },
    },
    operations: baseRecord.operations.map((operation) =>
      operation.id === operationId
        ? { ...operation, finishedAt: now, outcome: "failed" }
        : operation,
    ),
  };
  await note(
    context.operationLog,
    logErrors,
    `阶段 ${failure.stage} 失败：${failure.message}（收尾 ${cleanup.state}）`,
  );
  const recordProblem = await saveRecord(layout.recordPath, failedRecord);
  if (recordProblem !== undefined) logErrors.push(recordProblem);
  const logDirectory = path.join(layout.logsRoot, operationId);
  const files = await listFiles(logDirectory, logErrors);
  return {
    kind: "prepare",
    status: "failed",
    environment: failure.facts,
    failure: {
      stage: failure.stage,
      message: failedRecord.preparation.lastFailure?.message ?? failure.message,
      exitCode: failure.exitCode,
    },
    cleanup,
    logs: { directory: logDirectory, files },
    // 首因只在 failure.message 出现一次，避免同一错误在两处重复或互相覆盖。
    diagnostics: logErrors.filter((item) => item !== failure.message),
  };
}

/**
 * 准备不得覆盖被本记录管理的服务：活服务、启动中、停止未确认或进程身份不可判定的
 * 同世代存在时拒绝，已确认退出的陈旧运行分支才允许继续准备（并原样保留其历史）。
 */
function prepareBlockedByRun(record: EnvironmentRecord): string | undefined {
  const run = record.run;
  if (run === undefined) return undefined;
  if (run.state === "starting" || run.state === "stopping")
    return `本环境记录显示服务正在${run.state === "starting" ? "启动" : "停止"}，准备拒绝在收尾未确认时改动环境`;
  if (run.state !== "ready") return undefined;
  const liveness = observeLiveness(run.processIdentity);
  if (liveness === "exited") return undefined;
  return liveness === "alive"
    ? `本环境已有受记录管理的运行中服务（世代 ${run.runId}），先停止再准备`
    : `无法确认本环境受记录管理的进程是否仍在运行，准备拒绝改动环境`;
}

function incompatibleResult(
  request: PrepareRequest,
  layout: EnvironmentLayout,
  prior: EnvironmentRecord,
  differences: readonly string[],
): PrepareOperationResult {
  return {
    kind: "prepare",
    status: "config-incompatible",
    environment: environmentFacts(prior, layout),
    incompatibility: differences,
    failure: {
      stage: "request",
      message: `与已准备记录不一致：${differences.join("、")}；保留原状态，不隐式清空`,
      exitCode: null,
    },
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}

export function prepareFailureResult(
  request: PrepareRequest,
  message: string,
  stage: "request" | "claim" | "operation",
  layout: EnvironmentLayout | null,
): PrepareOperationResult {
  return {
    kind: "prepare",
    status:
      stage === "claim"
        ? "unmanaged"
        : stage === "request"
          ? "invalid-request"
          : "failed",
    environment: layout
      ? derivedFacts(request, layout)
      : invalidEnvironmentFacts(request.workspacePath, request.environment),
    failure: { stage, message, exitCode: null },
    // 这些失败点都发生在启动任何命令之前，因此收尾结论是尚未开始。
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}

async function checkArtifacts(
  workspacePath: string,
  buildExitedCleanly: boolean,
): Promise<string | undefined> {
  if (!buildExitedCleanly) return "构建命令未成功退出（见构建日志）";
  const artifacts = [
    path.join(workspacePath, migrationEntry),
    serviceEntryPath(workspacePath),
  ];
  for (const artifact of artifacts) {
    try {
      await readFile(artifact);
    } catch {
      return `构建后缺少交付产物：${path.relative(workspacePath, artifact)}`;
    }
  }
  return undefined;
}

/**
 * 载荷无法核验时没有可信请求，只能按请求阶段失败交出结果。
 */
export function prepareInvalidPayload(message: string): PrepareOperationResult {
  return prepareFailureResult(
    {
      kind: "prepare",
      workspacePath: process.cwd(),
      environment: "<invalid>",
      inputs: [],
      sourceMode: "invalid",
      config: {},
    },
    message,
    "request",
    null,
  );
}

/**
 * 操作内部没有形成结果时的最后兜底（例如布局核验之前就异常）：先真实收尾本次持有的
 * 子进程，再以实际收尾状态、已知日志位置和独立诊断如实上报，绝不宣称收尾完成。
 */
export async function prepareCrashResult(
  request: PrepareRequest,
  error: unknown,
  held: HeldCommands,
): Promise<PrepareOperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  const cleanup = await held.close();
  const diagnostics: string[] = [];
  const operationId =
    "reason" in layout ? undefined : await latestOperation(layout);
  const logDirectory =
    operationId === undefined || "reason" in layout
      ? null
      : path.join(layout.logsRoot, operationId);
  const files =
    logDirectory === null ? [] : await listFiles(logDirectory, diagnostics);
  return {
    kind: "prepare",
    status: "failed",
    environment:
      "reason" in layout
        ? invalidEnvironmentFacts(request.workspacePath, request.environment)
        : derivedFacts(request, layout),
    failure: {
      stage: "operation",
      message: `准备操作异常：${describeError(error)}`,
      exitCode: null,
    },
    cleanup,
    logs: { directory: logDirectory, files },
    diagnostics: [...diagnostics],
  };
}
