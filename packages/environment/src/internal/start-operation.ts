import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { OperationCancellation } from "./cancellation.ts";
import {
  createLaunchConfig,
  handoffMarkerTag,
  launchConfigEnvironmentVariable,
  writeLaunchConfig,
  type LaunchConfig,
} from "./launch-contract.ts";
import {
  invalidEnvironmentFacts,
  noRunFacts,
  recordedRunFacts,
  validateStartOrStopRequest,
  type EnvironmentFacts,
  type ProcessLiveness,
  type RunObservation,
  type StartFailureStage,
  type StartOperationResult,
  type StartRequest,
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
  writeOperationLog,
} from "./operation-support.ts";
import {
  createLayout,
  createOperationId,
  createPrivateRunDirectory,
  defaultWebPort,
  verifyDataOwnership,
  webEntryPath,
  type EnvironmentLayout,
} from "./paths.ts";
import { requestPrivateControl } from "./private-control.ts";
import {
  observeProcessIdentity,
  processIdentityProblem,
  sameProcessIdentity,
  type ProcessIdentity,
} from "./process-identity.ts";
import { filteredEnvironment } from "./processes.ts";
import {
  readRecord,
  type EnvironmentRecord,
  type EnvironmentRunRecord,
} from "./record.ts";
import { createDiagnosticRedactor, type DiagnosticRedactor } from "./redact.ts";
import {
  observeLiveness,
  observeRun,
  verifyRunTarget,
  type RunTarget,
} from "./run-observation.ts";
import { requireSourceSelectionEnvironment } from "./source-selection.ts";
import { terminalFactsPath, writeTerminalFacts } from "./terminal-facts.ts";

/** 握手、就绪认证与收尾等待都有界；任何超时都只如实报告，不猜测进程状态。 */
const handoffTimeoutMilliseconds = 30_000;
const identityTimeoutMilliseconds = 30_000;
const readyTimeoutMilliseconds = 120_000;
const readyPollMilliseconds = 250;
const controlTimeoutMilliseconds = 5_000;
const guideExitTimeoutMilliseconds = 10_000;
const admittedExitTimeoutMilliseconds = 40_000;
/**
 * 发布界限：外层引导取得进入许可后，父操作最迟必须在这段预算内把就绪事实写入记录
 * 并发出发布确认。握手（30 秒）+ 身份（30 秒）+ 就绪（120 秒）的预算之和是 180 秒，
 * 因此 240 秒之外的未发布世代只可能来自父操作自身已经结束或失联。
 */
const publishTimeoutMilliseconds = 240_000;

type IpcMessage = { readonly [key: string]: unknown };

type StartContext = {
  readonly record: EnvironmentRecord;
  readonly layout: EnvironmentLayout;
  readonly facts: EnvironmentFacts;
  readonly runId: string;
  readonly runtime: "production" | "development";
  readonly port: number;
  readonly address: string;
  readonly directory: string;
  readonly controlSocket: string;
  readonly launchConfigFile: string;
  readonly productLogFile: string;
  readonly operationId: string;
  readonly logDirectory: string;
  readonly operationLog: string;
  readonly logErrors: string[];
  readonly startedAt: string;
  /** 操作日志目录是否已经真实建立，未建立时不谎报日志位置。 */
  logCreated: boolean;
};

/**
 * 在持有同一环境锁的进程内启动真实产品 Web 服务：先确认既有运行分支的归属，
 * 再建立自有私有运行现场并保存启动意图，由外层引导提交精确进程身份，父操作
 * 核验身份、控制认证与真实 ready 签名都成立后才提交就绪事实。
 *
 * 取消只中止发布之前的等待：取消成立时世代尚未发布，本操作按普通失败路径收尾自己
 * 启动的进程（未准许就撤回许可、已准许就经私有控制通道请求一次自终止），收尾使用与
 * 已取消执行条件无关的原有有界宽限。就绪事实一旦写入记录并发布，本世代就归产品自己
 * 持有，取消不再撤销它。
 */
export async function runStartOperation(
  request: StartRequest,
  cancellation: OperationCancellation,
): Promise<StartOperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  if ("reason" in layout)
    return simpleResult(request, layout.reason, "request", null);
  const validation = validateStartOrStopRequest(request);
  if (validation !== undefined)
    return simpleResult(request, validation.reason, "request", layout);

  const read = await readRecord(layout.recordPath);
  if (read.kind === "absent")
    return simpleResult(
      request,
      "该环境没有准备记录，尚无被该记录管理的服务，拒绝启动",
      "claim",
      layout,
    );
  if (read.kind === "corrupt")
    return simpleResult(
      request,
      `环境记录损坏或版本未知，保留原件不接管：${read.reason}`,
      "claim",
      layout,
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
    return simpleResult(
      request,
      "环境记录与当前容器身份不一致，拒绝接管",
      "claim",
      layout,
    );
  const facts = environmentFacts(record, layout);
  if (request.developmentSession !== undefined) {
    if (
      record.development?.sessionId !== request.developmentSession ||
      record.development.state !== "active" ||
      request.runtime !== "development"
    )
      return simpleResult(
        request,
        "开发会话已结束或引用失效，拒绝迟到启动",
        "generation",
        layout,
        facts,
      );
  } else if (
    record.development !== undefined &&
    record.development.state !== "ended"
  )
    return simpleResult(
      request,
      "现有开发会话尚未结束，普通启动不能创建另一世代",
      "generation",
      layout,
      facts,
    );
  // 半收敛的破坏性意图现场不属于任何可启动世代：只指出该用哪个显式命令继续。
  if (record.destructive !== undefined)
    return simpleResult(
      request,
      `该环境存在未收敛的${
        record.destructive.kind === "delete" ? "删除" : "重建"
      }意图（操作 ${record.destructive.operationId}），启动拒绝在半收敛现场上进行；请用显式 ${record.destructive.kind} 命令收敛`,
      "generation",
      layout,
      facts,
    );
  if (record.preparation.state !== "prepared")
    return simpleResult(
      request,
      `环境尚未处于已准备状态（当前 ${record.preparation.state}），不启动服务`,
      "generation",
      layout,
      facts,
    );
  const ownership = await verifyDataOwnership(layout, record.inputs);
  if ("reason" in ownership)
    return simpleResult(request, ownership.reason, "claim", layout, facts);

  const existing = await evaluateExistingRun(record);
  if (existing.kind === "already-ready") {
    if (
      (record.run?.runtime ?? "production") !==
      (request.runtime ?? "production")
    )
      return refusedResult(
        record,
        layout,
        "现有世代使用另一入口；请先显式停止再切换开发或生产入口",
        existing.observation.processLiveness,
      );
    const unrecovered = await restorePublication(
      existing.target,
      existing.observation,
    );
    if (unrecovered !== undefined)
      return refusedResult(
        record,
        layout,
        unrecovered,
        existing.observation.processLiveness,
      );
    return await alreadyReadyResult(record, layout, existing.observation);
  }
  if (existing.kind === "refuse")
    return refusedResult(record, layout, existing.reason, existing.liveness);
  return await startFreshGeneration(
    record,
    layout,
    facts,
    cancellation,
    request.runtime ?? "production",
  );
}

/**
 * 就绪事实已写入记录、而本世代没有收到发布确认时，公开启动命令经同一私有通道把确认
 * 补齐，使同一 runId 可以持续地被重新确认。不能补齐时如实拒绝：绝不返回一个随后会被
 * 遗留发布计时主动关闭的正常成功结果。
 */
async function restorePublication(
  target: RunTarget,
  observation: RunObservation,
): Promise<string | undefined> {
  if (observation.controlState?.published !== false) return undefined;
  const run = target.run;
  const control = await requestPrivateControl({
    socketPath: run.controlSocket,
    environmentId: target.environmentId,
    runId: run.runId,
    controlKey: target.controlKey,
    kind: "publish",
    timeoutMilliseconds: controlTimeoutMilliseconds,
  });
  if ("reason" in control)
    return `本世代的记录已提交就绪却没有发布确认，私有控制通道未能补齐确认：${control.reason}`;
  if (
    control.reply.accepted !== true ||
    control.reply.state?.published !== true
  )
    return `本世代的记录已提交就绪却没有发布确认，本世代不接受该确认：${
      control.reply.reason ?? "原因未说明"
    }`;
  return undefined;
}

/**
 * 既有运行分支只由本记录自己的私有现场与同一进程身份解释：确认已退出才可取代，
 * 活服务认证通过就是已就绪，其余一律拒绝，不猜测、不接管、不换端口。
 */
async function evaluateExistingRun(record: EnvironmentRecord): Promise<
  | { readonly kind: "proceed" }
  | {
      readonly kind: "already-ready";
      readonly observation: RunObservation;
      readonly target: RunTarget;
    }
  | {
      readonly kind: "refuse";
      readonly reason: string;
      readonly liveness: ProcessLiveness;
    }
> {
  const run = record.run;
  if (run === undefined || run.state === "stopped") return { kind: "proceed" };
  const liveness = observeLiveness(run.processIdentity);
  const target = await verifyRunTarget(record);
  if ("reason" in target)
    return {
      kind: "refuse",
      reason: `既有运行分支的私有现场无法确认为本环境自有，拒绝接管：${target.reason}`,
      liveness,
    };
  if (liveness === "unknown")
    return {
      kind: "refuse",
      reason: "无法确认既有世代进程是否仍在运行，不猜测也不启动第二个服务",
      liveness,
    };
  if (liveness === "exited") return { kind: "proceed" };
  const observation = await observeRun(record, target.target, {
    controlTimeoutMilliseconds: controlTimeoutMilliseconds,
    readyTimeoutMilliseconds: controlTimeoutMilliseconds,
  });
  if (run.state !== "ready")
    return {
      kind: "refuse",
      reason: `既有世代进程仍在运行且处于 ${run.state} 状态，不启动第二个服务`,
      liveness,
    };
  if (observation.serviceReady === true && observation.controlReachable)
    return {
      kind: "already-ready",
      observation,
      target: target.target,
    };
  return {
    kind: "refuse",
    reason: `既有世代服务仍在运行但没有同时通过控制认证与真实 ready 认证：${
      observation.refusalReason ?? observation.readyReason ?? "认证未成立"
    }`,
    liveness,
  };
}

/** 新世代：私有运行现场、启动意图、外层引导、进入产品许可与就绪认证。 */
async function startFreshGeneration(
  record: EnvironmentRecord,
  layout: EnvironmentLayout,
  facts: EnvironmentFacts,
  cancellation: OperationCancellation,
  runtime: "production" | "development",
): Promise<StartOperationResult> {
  const runId = randomUUID();
  const privateRun = createPrivateRunDirectory(
    layout.workspacePath,
    record.environmentId,
    runId,
  );
  if ("reason" in privateRun)
    return earlyFailure(record, facts, "operation", privateRun.reason);
  const directory = privateRun.directory;
  const operationId = createOperationId(new Date());
  const logDirectory = path.join(layout.logsRoot, operationId);
  const context: StartContext = {
    record,
    layout,
    facts,
    runId,
    runtime,
    port: 0,
    address: "",
    directory,
    controlSocket: path.join(directory, "control.sock"),
    launchConfigFile: path.join(directory, "launch.json"),
    productLogFile: path.join(directory, "product.log"),
    operationId,
    logDirectory,
    operationLog: path.join(logDirectory, "operation.log"),
    logErrors: [],
    startedAt: new Date().toISOString(),
    logCreated: false,
  };
  /**
   * 失败收尾必须知道异常发生在哪一步之后：记录一旦指向本世代，就只能沿用自有世代的
   * 收尾路径，绝不套用「没有进程、没有记录引用」的未启动结果。
   */
  const progress: {
    live: StartContext;
    config?: LaunchConfig;
    intent?: EnvironmentRecord;
    child?: ChildProcess;
    exit?: ExitObserver;
  } = { live: context };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const privateIdentity = await directoryIdentity(directory);
    if (privateIdentity === undefined)
      return await failBeforeIntent(context, "operation", {
        message: `私有运行目录身份无法核验：${directory}`,
        removePrivateDirectory: true,
      });
    const config = createLaunchConfig({
      environmentId: record.environmentId,
      runId,
      controlSocket: context.controlSocket,
      productLogFile: context.productLogFile,
      // 引导把这一绝对终点当作发布界限：握手、身份与就绪三段预算之和为 180 秒，
      // 超过它就说明父操作再也不会将本世代交出去，未发布的进程自行收尾。
      publishDeadlineAt: Date.now() + publishTimeoutMilliseconds,
    });
    progress.config = config;
    const port = selectPort(record);
    const conflict = await portProblem(port);
    if (conflict !== undefined)
      return await failBeforeIntent(context, "port", {
        message: conflict,
        port,
        removePrivateDirectory: true,
      });
    await writeLaunchConfig(context.launchConfigFile, config);

    const operation = {
      id: operationId,
      kind: "start" as const,
      startedAt: context.startedAt,
      logDirectory: path.posix.join("logs", operationId),
    };
    const intent = withRunRecord(withOperation(record, operation), {
      runId,
      runtime,
      state: "starting",
      startedAt: context.startedAt,
      updatedAt: new Date().toISOString(),
      port,
      address: `http://127.0.0.1:${String(port)}`,
      privateDirectory: directory,
      privateDirectoryIdentity: privateIdentity,
      controlSocket: context.controlSocket,
      launchConfigFile: context.launchConfigFile,
      productLogFile: context.productLogFile,
      startOperationId: operationId,
    });
    const live: StartContext = {
      ...context,
      port,
      address: intent.run?.address ?? "",
    };
    progress.live = live;
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    live.logCreated = true;
    await note(
      live.operationLog,
      live.logErrors,
      `start ${layout.environment} 开始；操作 ${operationId}，世代 ${runId}，端口 ${String(port)}`,
    );
    const intentProblem = await saveRecord(layout.recordPath, intent);
    if (intentProblem !== undefined)
      return await failBeforeIntent(live, "intent", {
        message: `启动意图无法写入记录：${intentProblem}`,
        removePrivateDirectory: true,
      });
    progress.intent = intent;

    const entry =
      runtime === "development"
        ? path.join(
            layout.workspacePath,
            "apps",
            "web",
            "scripts",
            "start-development.ts",
          )
        : webEntryPath(layout.workspacePath);
    const child = spawn(
      process.execPath,
      [
        ...(runtime === "development"
          ? ["--conditions=digital-development"]
          : []),
        "--import",
        pathToFileURL(guideEntryPath()).href,
        entry,
      ],
      {
        cwd: layout.workspacePath,
        detached: true,
        env: filteredEnvironment(process.env, {
          DIGITAL_PRODUCT_DATA: layout.productDataRoot,
          PORT: String(port),
          ...(runtime === "development"
            ? {
                DIGITAL_DEVELOPMENT: "1",
                DIGITAL_DEVELOPMENT_CACHE: path.join(
                  layout.workspacePath,
                  ".turbo",
                  "development",
                  "vite",
                  record.environmentId,
                ),
              }
            : {}),
          [launchConfigEnvironmentVariable]: context.launchConfigFile,
          // 世代只按记录里已核验的选择装配来源，父进程的来源变量不会渗入。
          ...requireSourceSelectionEnvironment({
            sourceMode: intent.sourceMode,
            config: intent.config,
            workspacePath: layout.workspacePath,
          }),
        }),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    progress.child = child;
    const inbox = new IpcInbox(child);
    const exit = new ExitObserver(child);
    progress.exit = exit;
    await note(
      live.operationLog,
      live.logErrors,
      `已启动外层引导（PID ${String(child.pid ?? "未知")}，入口 ${entry}）`,
    );
    return await handshakeAndAdmit(
      live,
      intent,
      config,
      child,
      inbox,
      exit,
      cancellation,
    );
  } catch (error) {
    const reason = `启动操作异常：${describeError(error)}`;
    if (progress.config !== undefined && progress.intent !== undefined)
      return await terminateAndFail(
        progress.live,
        progress.intent,
        progress.config,
        progress.child,
        progress.exit ?? new ExitObserver(progress.child),
        "operation",
        reason,
      );
    // 记录还没有指向本世代：本次自建的私有现场是唯一残留，收回它，失败时交出确切路径。
    return await failBeforeIntent(progress.live, "operation", {
      message: reason,
      removePrivateDirectory: true,
    });
  }
}

/**
 * 双流交接标记与精确进程身份都必须来自我们亲自启动的那个进程；身份写入记录之后
 * 才给进入正式入口的许可，再用控制认证与真实 ready 签名确认服务确实就绪才提交。
 * 这三段等待都可被取消打断；被打断后本世代仍未发布，交给 terminateAndFail 用原有
 * 有界宽限收尾，取消本身作为首因保留。
 */
async function handshakeAndAdmit(
  context: StartContext,
  intent: EnvironmentRecord,
  config: LaunchConfig,
  child: ChildProcess,
  inbox: IpcInbox,
  exit: ExitObserver,
  cancellation: OperationCancellation,
): Promise<StartOperationResult> {
  const handoff = await cancellation.watch(
    awaitHandoff(child, config, context),
  );
  if (handoff.cancelled)
    return await terminateAndFail(
      context,
      intent,
      config,
      child,
      exit,
      "handshake",
      `${cancellation.reason()}：本世代尚未发布，由本次启动收尾自己拉起的进程`,
    );
  if ("reason" in handoff.value)
    return await terminateAndFail(
      context,
      intent,
      config,
      child,
      exit,
      "handshake",
      handoff.value.reason,
    );

  const taken = await cancellation.watch(
    inbox.take("identity", identityTimeoutMilliseconds, exit),
  );
  if (taken.cancelled)
    return await terminateAndFail(
      context,
      intent,
      config,
      child,
      exit,
      "handshake",
      `${cancellation.reason()}：本世代尚未提交进程身份，未发布的世代由本次启动收尾`,
    );
  const message = taken.value;
  if (message === undefined)
    return await terminateAndFail(
      context,
      intent,
      config,
      child,
      exit,
      "handshake",
      `没有收到本世代进程身份提交（引导进程${exit.description()}）`,
    );
  const problem = identityProblem(message, config, child);
  if (problem !== undefined)
    return await terminateAndFail(
      context,
      intent,
      config,
      child,
      exit,
      "handshake",
      problem,
    );
  const identity = message.identity as ProcessIdentity;
  const withIdentity = withRunRecord(intent, {
    runId: context.runId,
    processIdentity: identity,
    updatedAt: new Date().toISOString(),
  });
  const saved = await saveRecord(context.layout.recordPath, withIdentity);
  if (saved !== undefined)
    return await terminateAndFail(
      context,
      withIdentity,
      config,
      child,
      exit,
      "intent",
      `进程身份无法写入记录，因此不准许进入正式入口：${saved}`,
    );

  child.send({ type: "admit", runId: config.runId });
  await note(
    context.operationLog,
    context.logErrors,
    `身份已提交并记录，准许本世代进入正式入口（PID ${String(identity.pid)}）`,
  );
  const watchedReady = await cancellation.watch(awaitReady(withIdentity, exit));
  if (watchedReady.cancelled)
    return await terminateAndFail(
      context,
      withIdentity,
      config,
      child,
      exit,
      "ready",
      `${cancellation.reason()}：本世代尚未发布，由本次启动经私有控制通道请求它自行收尾`,
    );
  const ready = watchedReady.value;
  if ("reason" in ready)
    return await terminateAndFail(
      context,
      withIdentity,
      config,
      child,
      exit,
      "ready",
      ready.reason,
    );

  const readyRecord = withRunRecord(withIdentity, {
    runId: context.runId,
    state: "ready",
    updatedAt: new Date().toISOString(),
    logHealth: ready.observation.logHealth ?? "unknown",
  });
  const committed = finishOperation(readyRecord, context.operationId, "ready");
  /**
   * 提交截止点与就绪事实的 rename 落在同一个不含事件循环轮次的同步块内（见
   * writeRecordAtomic）：取消在这之前成立就一律不提交、不发布，按取消首因收尾；
   * 只有真正提交完成之后才成立的迟到取消不撤销，因为那一世代已经归产品自己持有。
   */
  const commitGate = (): string | undefined =>
    cancellation.triggered()
      ? `${cancellation.reason()}：就绪事实未提交，取消在提交截止点之前成立`
      : undefined;
  const commitProblem = await saveRecord(
    context.layout.recordPath,
    committed,
    commitGate,
  );
  if (commitProblem !== undefined) {
    if (cancellation.triggered())
      return await terminateAndFail(
        context,
        withIdentity,
        config,
        child,
        exit,
        "ready",
        `${cancellation.reason()}：就绪事实未提交记录，本世代尚未发布，由本次启动经私有控制通道请求它自行收尾`,
      );
    return await terminateAndFail(
      context,
      readyRecord,
      config,
      child,
      exit,
      "operation",
      `服务已就绪但就绪事实无法写入记录，按普通启动失败收尾：${commitProblem}`,
    );
  }
  await note(
    context.operationLog,
    context.logErrors,
    `已就绪（世代 ${context.runId}，地址 ${context.address}，日志 ${context.productLogFile}）`,
  );
  child.send({ type: "published", runId: config.runId });
  child.unref();
  child.disconnect();
  // 本操作只把世代交给产品自己持有；父端管道读句柄不释放会把操作进程吊住，
  // 让独立 CLI 永远等不到结果。
  child.stdout?.destroy();
  child.stderr?.destroy();
  await retireSupersededGeneration(
    context.record,
    context.runId,
    context.logErrors,
  );
  return {
    kind: "start",
    status: "ready",
    environment: context.facts,
    run: {
      ...recordedRunFacts(committed),
      processLiveness: ready.observation.processLiveness,
      controlReachable: ready.observation.controlReachable,
      serviceReady: true,
      logHealth: ready.observation.logHealth ?? "unknown",
    },
    // 就绪即本世代继续运行：本次释放的是操作句柄，不是把服务收尾停止。
    cleanup: { state: "released", errors: [] },
    logs: {
      directory: context.logDirectory,
      files: await listFiles(context.logDirectory, context.logErrors),
    },
    diagnostics: [...context.logErrors],
  };
}

/** 控制认证、真实 ready 签名与同一活进程同时成立才算就绪。 */
async function awaitReady(
  record: EnvironmentRecord,
  exit: ExitObserver,
): Promise<
  { readonly observation: RunObservation } | { readonly reason: string }
> {
  const deadline = Date.now() + readyTimeoutMilliseconds;
  let lastReason = "尚未取得就绪认证";
  for (;;) {
    if (exit.terminated())
      return {
        reason: `本世代进程在确认就绪之前已经结束（${exit.description()}）`,
      };
    const target = await verifyRunTarget(record);
    if ("reason" in target) lastReason = target.reason;
    else {
      const observation = await observeRun(record, target.target, {
        controlTimeoutMilliseconds: controlTimeoutMilliseconds,
        readyTimeoutMilliseconds: controlTimeoutMilliseconds,
      });
      if (
        observation.processLiveness === "alive" &&
        observation.controlReachable &&
        observation.serviceReady === true &&
        observation.controlState?.phase === "serving"
      )
        return { observation };
      lastReason =
        observation.refusalReason ??
        observation.readyReason ??
        `控制通道或真实 ready 认证尚未成立（进程 ${observation.processLiveness}，阶段 ${String(
          observation.controlState?.phase ?? "未知",
        )}）`;
    }
    if (Date.now() >= deadline)
      return {
        reason: `在 ${String(readyTimeoutMilliseconds)} 毫秒内没有确认本世代服务就绪：${lastReason}`,
      };
    await delay(readyPollMilliseconds);
  }
}

/**
 * 没有取得就绪的世代由本次启动自己收尾：未准许进入就撤回许可，已准许就经私有控制
 * 通道请求一次自身 SIGTERM，然后确认进程真实结束（真实退出，或系统从未放行）。
 * 只有确认结束且终结事实成功写入记录，才记为已停止并释放本世代秘密与失联控制地址
 * （运行日志随目录保留）。结束无法确认、或记录没能保存（记录因此仍指向本世代）时，
 * 启动中事实与私有现场都原样保留并交回精确指针，由后续公开停止命令收尾。
 */
async function terminateAndFail(
  context: StartContext,
  record: EnvironmentRecord,
  config: LaunchConfig,
  child: ChildProcess | undefined,
  exit: ExitObserver,
  stage: StartFailureStage,
  message: string,
): Promise<StartOperationResult> {
  const admitted = stage === "ready" || stage === "operation";
  if (!exit.terminated() && child !== undefined) {
    if (admitted) await controlStop(record, config);
    else child.send({ type: "refuse", runId: config.runId, reason: message });
  }
  const confirmed = await exit.await(
    admitted ? admittedExitTimeoutMilliseconds : guideExitTimeoutMilliseconds,
  );
  // 这是本次亲自启动的进程句柄，不是按 PID 猜测的接管；从未启动的世代没有进程可发信号。
  if (!confirmed && child?.pid !== undefined) child.kill("SIGTERM");
  const stopped = confirmed || (await exit.await(guideExitTimeoutMilliseconds));
  const failure = createDiagnosticRedactor([
    config.controlKey,
    config.readyKey,
  ])(`${message}（进程事实：${exit.description()}）`);
  await note(
    context.operationLog,
    context.logErrors,
    `启动失败（阶段 ${stage}）：${failure}（收尾 ${stopped ? "已确认结束" : "无法确认"}）`,
  );
  const now = new Date().toISOString();
  const failedRecord = withRunRecord(record, {
    runId: context.runId,
    state: stopped ? "stopped" : "starting",
    updatedAt: now,
    logHealth: "unknown",
    lastFailure: { stage, message: failure },
    ...(stopped && exit.hasExited
      ? { ended: { at: now, code: exit.code, signal: exit.signal } }
      : {}),
  });
  const saved = await saveRecord(
    context.layout.recordPath,
    stopped
      ? finishOperation(failedRecord, context.operationId, "failed")
      : failedRecord,
  );
  if (saved === undefined) {
    if (stopped) {
      const retired = failedRecord.run;
      if (retired !== undefined)
        context.logErrors.push(...(await releaseRunSecrets(retired)));
    }
    return await failedStartResult(
      context,
      failedRecord,
      stage,
      failure,
      exit,
      {
        state: stopped ? "stopped" : "unknown",
        errors: stopped
          ? []
          : [
              "本世代进程未能确认结束，已保留私有运行现场与启动中事实以便后续停止",
            ],
      },
    );
  }
  // 终结事实写不进记录时，磁盘上的记录仍然指向本世代：本世代秘密与私有现场是唯一
  // 还能把它核验清楚的恢复线索，销毁后就再没有任何公开命令能确认收尾。这里把已经
  // 亲自观察到的身份、终结与首因留在同一私有现场，并交出精确的后续停止指针。
  context.logErrors.push(saved);
  const observedRun = failedRecord.run;
  const observedIdentity = observedRun?.processIdentity;
  const factsProblem =
    observedIdentity === undefined
      ? "本世代尚未提交进程身份，私有现场之外没有可留存的恢复事实"
      : await writeTerminalFacts(context.directory, {
          environmentId: context.record.environmentId,
          runId: context.runId,
          processIdentity: observedIdentity,
          ...(stopped && exit.hasExited
            ? { ended: { at: now, code: exit.code, signal: exit.signal } }
            : {}),
          lastFailure: { stage, message: failure },
        });
  if (factsProblem !== undefined) context.logErrors.push(factsProblem);
  const pointer = `私有目录 ${context.directory}、启动配置 ${context.launchConfigFile}、运行日志 ${context.productLogFile}${
    observedIdentity === undefined
      ? ""
      : `、终结事实 ${terminalFactsPath(context.directory)}`
  }`;
  await note(
    context.operationLog,
    context.logErrors,
    `终结事实未能写入记录（${saved}），保留本世代现场与秘密：${pointer}`,
  );
  return await failedStartResult(context, failedRecord, stage, failure, exit, {
    state: "unknown",
    errors: [
      `终结事实未能写入记录，本世代秘密、身份与终结事实都保留在同一私有现场，请对同一环境再次发出公开停止命令：${pointer}`,
    ],
  });
}

/** 启动失败的统一结果形状：只交出已处置过的事实，不重复观察进程。 */
async function failedStartResult(
  context: StartContext,
  failedRecord: EnvironmentRecord,
  stage: StartFailureStage,
  failure: string,
  exit: ExitObserver,
  cleanup: {
    readonly state: "stopped" | "unknown";
    readonly errors: readonly string[];
  },
): Promise<StartOperationResult> {
  return {
    kind: "start",
    status: "failed",
    environment: context.facts,
    run: recordedRunFacts(failedRecord),
    failure: { stage, message: failure, exitCode: exit.code },
    cleanup,
    logs: context.logCreated
      ? {
          directory: context.logDirectory,
          files: await listFiles(context.logDirectory, context.logErrors),
        }
      : { directory: null, files: [] },
    diagnostics: [...context.logErrors],
  };
}

async function controlStop(
  record: EnvironmentRecord,
  config: LaunchConfig,
): Promise<void> {
  const run = record.run;
  if (run === undefined) return;
  await requestPrivateControl({
    socketPath: run.controlSocket,
    environmentId: record.environmentId,
    runId: run.runId,
    controlKey: config.controlKey,
    kind: "stop",
    timeoutMilliseconds: controlTimeoutMilliseconds,
  });
}

/**
 * 写入启动意图之前的失败只收回本次自建目录：此时没有记录或日志指向它。收回失败时
 * 交出确切路径，绝不把仍然存在的秘密说成已经收回。
 */
async function removeOwnPrivateDirectory(
  directory: string,
): Promise<string | undefined> {
  try {
    await rm(directory, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return `本世代私有运行资源未能收回，请人工核验后清理：${directory}（${describeError(error)}）`;
  }
}

/** 已就绪的同一世代：返回同一 runId 与地址，不创建第二个服务进程。 */
async function alreadyReadyResult(
  record: EnvironmentRecord,
  layout: EnvironmentLayout,
  observation: RunObservation,
): Promise<StartOperationResult> {
  const operationId = createOperationId(new Date());
  const logDirectory = path.join(layout.logsRoot, operationId);
  const operationLog = path.join(logDirectory, "operation.log");
  const logErrors: string[] = [];
  const saved = await saveRecord(
    layout.recordPath,
    withOperation(
      record,
      {
        id: operationId,
        kind: "start",
        startedAt: new Date().toISOString(),
        logDirectory: path.posix.join("logs", operationId),
      },
      "already-ready",
    ),
  );
  await mkdir(logDirectory, { recursive: true, mode: 0o700 }).catch(() => {
    logErrors.push("已就绪历史日志目录无法建立");
  });
  await note(
    operationLog,
    logErrors,
    `start ${layout.environment}：世代 ${observation.runId} 已在提供认证服务（${observation.address}），不创建第二个进程`,
  );
  if (saved !== undefined) logErrors.push(saved);
  return {
    kind: "start",
    status: "already-ready",
    environment: environmentFacts(record, layout),
    run: observation,
    cleanup: { state: "not-started", errors: [] },
    logs: {
      directory: logDirectory,
      files: await listFiles(logDirectory, logErrors),
    },
    diagnostics: [...logErrors],
  };
}

/**
 * 尚未建立意图记录之前的失败：不改记录、不谎报日志位置。此时没有任何记录或进程指向
 * 本次自建的私有现场，因此必须收回它，否则本世代秘密会留下无人引用的残留；收回真实
 * 失败时交出确切路径，不把残留说成已收回。
 */
async function failBeforeIntent(
  context: StartContext,
  stage: StartFailureStage,
  input: {
    readonly message: string;
    readonly port?: number;
    readonly removePrivateDirectory?: boolean;
  },
): Promise<StartOperationResult> {
  const message = createDiagnosticRedactor([])(input.message);
  const reclaimErrors: string[] = [];
  if (input.removePrivateDirectory === true) {
    const problem = await removeOwnPrivateDirectory(context.directory);
    if (problem !== undefined) {
      context.logErrors.push(problem);
      reclaimErrors.push(problem);
    }
  }
  const facts = recordedRunFacts(context.record);
  return {
    kind: "start",
    status: "failed",
    environment: context.facts,
    run: {
      ...facts,
      ...(input.port === undefined ? {} : { port: input.port }),
      lastFailure: { stage, message },
    },
    failure: { stage, message, exitCode: null },
    // 这些失败点都发生在写入启动意图与启动任何进程之前。
    cleanup: { state: "not-started", errors: reclaimErrors },
    logs: context.logCreated
      ? {
          directory: context.logDirectory,
          files: await listFiles(context.logDirectory, context.logErrors),
        }
      : { directory: null, files: [] },
    diagnostics: [...context.logErrors],
  };
}

function earlyFailure(
  record: EnvironmentRecord,
  facts: EnvironmentFacts,
  stage: StartFailureStage,
  reason: string,
): StartOperationResult {
  const message = createDiagnosticRedactor([])(reason);
  return {
    kind: "start",
    status: "failed",
    environment: facts,
    run: { ...recordedRunFacts(record), lastFailure: { stage, message } },
    failure: { stage, message, exitCode: null },
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}

function refusedResult(
  record: EnvironmentRecord,
  layout: EnvironmentLayout,
  reason: string,
  liveness: ProcessLiveness,
): StartOperationResult {
  const message = createDiagnosticRedactor([])(reason);
  return {
    kind: "start",
    status: "refused",
    environment: environmentFacts(record, layout),
    run: { ...recordedRunFacts(record), processLiveness: liveness },
    failure: { stage: "generation", message, exitCode: null },
    // 拒绝发生在启动任何新进程之前，记录与私有现场都原样保留。
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}

function simpleResult(
  request: StartRequest,
  message: string,
  stage: "request" | "claim" | "generation",
  layout: EnvironmentLayout | null,
  facts?: EnvironmentFacts,
): StartOperationResult {
  return {
    kind: "start",
    status:
      stage === "claim"
        ? "unmanaged"
        : stage === "request"
          ? "invalid-request"
          : "refused",
    environment:
      facts ??
      (layout === null
        ? invalidEnvironmentFacts(request.workspacePath, request.environment)
        : derivedFacts(request, layout)),
    run: noRunFacts,
    failure: { stage, message, exitCode: null },
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}

function selectPort(record: EnvironmentRecord): number {
  const configured = record.config.webPort;
  return typeof configured === "number" && Number.isInteger(configured)
    ? configured
    : defaultWebPort(record.environmentId);
}

/** 端口只被其他服务占用时清楚失败：不自动换端口，也不接管别人的监听。 */
async function portProblem(port: number): Promise<string | undefined> {
  const probe = createServer();
  const failure = await new Promise<string | undefined>((resolve) => {
    probe.once("error", (error: NodeJS.ErrnoException) =>
      resolve(
        error.code === "EADDRINUSE"
          ? `端口 ${String(port)} 已被其他服务占用，本环境不接管也不自动换端口`
          : `端口 ${String(port)} 无法确认空闲：${error.message}`,
      ),
    );
    probe.listen({ port, host: "127.0.0.1" }, () => resolve(undefined));
  });
  if (failure !== undefined) {
    probe.close();
    return failure;
  }
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return undefined;
}

function identityProblem(
  message: IpcMessage,
  config: LaunchConfig,
  child: ChildProcess,
): string | undefined {
  if (
    message.runId !== config.runId ||
    message.environmentId !== config.environmentId
  )
    return "进程身份提交里的本世代标识与启动配置不一致";
  const problem = processIdentityProblem(message.identity);
  if (problem !== undefined) return `本世代进程身份无效：${problem}`;
  const observed = observeProcessIdentity(child.pid ?? -1);
  if (!("identity" in observed))
    return `无法核验本世代进程身份：${observed.reason}`;
  if (
    !sameProcessIdentity(observed.identity, message.identity as ProcessIdentity)
  )
    return "提交的实际进程身份与本次亲自启动的进程不符";
  if (message.controlSocket !== config.controlSocket)
    return "提交的私有控制地址与本次生成的地址不符";
  return undefined;
}

/**
 * 引导在安装脱敏接收端之前写向管道的输出，就是本世代最早可核验的失败现场：父操作
 * 必须把它完整排空、解码、脱敏并逐行落盘，包括没有换行的尾部与超长行，不设字节上限。
 * 双流交接标记只有在这些输出也真实写入操作日志后才算交接成功；落盘失败时不准许进入
 * 正式入口，因为此后没有任何父侧出口能看到引导的输出。
 */
async function awaitHandoff(
  child: ChildProcess,
  config: LaunchConfig,
  context: StartContext,
): Promise<{ readonly ok: true } | { readonly reason: string }> {
  const markers: Record<"stdout" | "stderr", string> = {
    stdout: `${handoffMarkerTag} ${config.handoff.stdout}`,
    stderr: `${handoffMarkerTag} ${config.handoff.stderr}`,
  };
  const seen: Record<"stdout" | "stderr", boolean> = {
    stdout: false,
    stderr: false,
  };
  const secrets = [
    config.controlKey,
    config.readyKey,
    config.handoff.stdout,
    config.handoff.stderr,
  ];
  const redactors: Record<"stdout" | "stderr", DiagnosticRedactor> = {
    stdout: createDiagnosticRedactor(secrets),
    stderr: createDiagnosticRedactor(secrets),
  };
  const pipes: Record<
    "stdout" | "stderr",
    {
      readonly decoder: StringDecoder;
      readonly stream: NodeJS.ReadableStream | undefined;
      pending: string;
      ended: boolean;
      flushed: boolean;
    }
  > = {
    stdout: {
      decoder: new StringDecoder("utf8"),
      stream: child.stdout ?? undefined,
      pending: "",
      ended: child.stdout === undefined,
      flushed: false,
    },
    stderr: {
      decoder: new StringDecoder("utf8"),
      stream: child.stderr ?? undefined,
      pending: "",
      ended: child.stderr === undefined,
      flushed: false,
    },
  };
  let persistProblem: string | undefined;
  let writes: Promise<void> = Promise.resolve();
  const detach: (() => void)[] = [];

  const persist = (name: "stdout" | "stderr", body: string): void => {
    if (body.length === 0) return;
    const message = `引导${name === "stdout" ? "out " : "err "}${body}`;
    writes = writes.then(async () => {
      const problem = await writeOperationLog(context.operationLog, message);
      if (problem === undefined) return;
      context.logErrors.push(problem);
      persistProblem ??= problem;
    });
  };

  /** 行内内容按行交给增量脱敏器；标记行只用于判定归属，不落日志。 */
  const accept = (name: "stdout" | "stderr", line: string): void => {
    if (line.trimEnd() === markers[name]) {
      seen[name] = true;
      return;
    }
    const text = redactors[name].write(`${line}\n`);
    if (text.length > 0) persist(name, text);
  };

  const flush = (): void => {
    for (const name of ["stdout", "stderr"] as const) {
      const pipe = pipes[name];
      if (pipe.flushed) continue;
      pipe.flushed = true;
      const tail = `${pipe.pending}${pipe.decoder.end()}`;
      pipe.pending = "";
      if (tail.length > 0) accept(name, tail);
      const trailing = redactors[name].end();
      if (trailing.length > 0) persist(name, trailing);
    }
  };

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const off of detach) off();
      resolve();
    };
    const timer = setTimeout(settle, handoffTimeoutMilliseconds);
    for (const name of ["stdout", "stderr"] as const) {
      const pipe = pipes[name];
      const stream = pipe.stream;
      if (stream === undefined) continue;
      const onData = (chunk: Buffer): void => {
        pipe.pending += pipe.decoder.write(chunk);
        const lines = pipe.pending.split("\n");
        pipe.pending = lines.pop() ?? "";
        for (const line of lines) {
          accept(name, line);
          if (seen.stdout && seen.stderr) {
            settle();
            return;
          }
        }
      };
      const onEnd = (): void => {
        pipe.ended = true;
        if (pipes.stdout.ended && pipes.stderr.ended) settle();
      };
      stream.on("data", onData);
      stream.once("end", onEnd);
      stream.once("close", onEnd);
      detach.push(() => {
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("close", onEnd);
      });
    }
  });
  flush();
  await writes;
  if (persistProblem !== undefined)
    return {
      reason: `引导管道输出未能完整写入操作日志，因此不准许进入正式入口：${persistProblem}`,
    };
  if (seen.stdout && seen.stderr) return { ok: true };
  return {
    reason: `外层引导没有交出完整的双流交接标记（标准输出 ${
      seen.stdout ? "已收到" : "缺失"
    }、标准错误 ${seen.stderr ? "已收到" : "缺失"}）`,
  };
}

/** 有界缓存父操作与引导之间的初始化 IPC；监听器先建立，因此不丢早到的消息。 */
class IpcInbox {
  private readonly queue: IpcMessage[] = [];
  private readonly waiting: ((message: IpcMessage | undefined) => void)[] = [];
  private readonly exited: (() => void)[] = [];

  constructor(child: ChildProcess) {
    child.on("message", (message: unknown) => {
      const value = (
        typeof message === "object" && message !== null ? message : {}
      ) as IpcMessage;
      const waiter = this.waiting.shift();
      if (waiter === undefined) this.queue.push(value);
      else waiter(value);
    });
    const wake = (): void => {
      for (const listener of this.exited.splice(0)) listener();
    };
    child.once("exit", wake);
    // 从未启动的句柄只有 close 没有 exit：等待者必须立刻知道不会再有消息。
    child.once("close", wake);
  }

  async take(
    type: string,
    timeoutMilliseconds: number,
    exit: ExitObserver,
  ): Promise<IpcMessage | undefined> {
    const deadline = Date.now() + timeoutMilliseconds;
    for (;;) {
      const index = this.queue.findIndex((item) => item.type === type);
      if (index >= 0) return this.queue.splice(index, 1)[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0 || exit.terminated()) return undefined;
      const received = await Promise.race([
        new Promise<IpcMessage | undefined>((resolve) => {
          this.waiting.push(resolve);
          setTimeout(() => resolve(undefined), remaining);
        }),
        this.onExit().then(() => undefined),
      ]);
      if (received === undefined) continue;
      if (received.type === type) return received;
      this.queue.push(received);
    }
  }

  private onExit(): Promise<void> {
    return new Promise((resolve) => this.exited.push(resolve));
  }
}

/**
 * 只观察本次亲自启动的进程是否真的结束，并保留可报告的终结事实。`close` 总是跟在
 * `exit` 之后；只有进程从未启动（系统直接拒绝 spawn）才会出现只有 `close` 而没有
 * `exit`，这同样是可断定的终结事实，不是无法确认。首个 OS 错误一经记录就不被后续
 * 事件覆盖，因为它是原始失败的第一现场。
 */
class ExitObserver {
  code: number | null = null;
  signal: NodeJS.Signals | null = null;
  hasExited = false;
  /** 系统拒绝了启动：本世代从未成为运行中的进程。 */
  neverStarted = false;
  osError: string | undefined;
  private readonly listeners: (() => void)[] = [];

  constructor(child: ChildProcess | undefined) {
    if (child === undefined) {
      // 启动请求连系统都没有放行，本世代不存在任何进程句柄可观察。
      this.neverStarted = true;
      this.osError = "无法观察：启动请求未能交给系统";
      return;
    }
    child.once("exit", (code, signal) => {
      this.hasExited = true;
      this.code = code;
      this.signal = signal;
      this.wake();
    });
    child.once("close", () => {
      if (!this.hasExited) this.neverStarted = true;
      this.wake();
    });
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      this.osError ??= `${code ?? "未知错误码"}：${error.message}`;
    });
  }

  /** 本世代是否已经确定结束：真实退出，或从未启动。 */
  terminated(): boolean {
    return this.hasExited || this.neverStarted;
  }

  description(): string {
    const facts: string[] = [];
    if (this.osError !== undefined) facts.push(`系统错误 ${this.osError}`);
    facts.push(
      this.hasExited
        ? `退出码 ${String(this.code)} 信号 ${String(this.signal)}`
        : this.neverStarted
          ? "本世代进程从未启动"
          : "仍在运行",
    );
    return facts.join("；");
  }

  async await(timeoutMilliseconds: number): Promise<boolean> {
    if (this.terminated()) return true;
    return new Promise((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(false), timeoutMilliseconds);
      this.listeners.push(() => {
        if (this.terminated()) done(true);
      });
    });
  }

  private wake(): void {
    for (const listener of this.listeners.splice(0)) listener();
  }
}

/** 运行分支只按本次操作增量更新，其余记录字段原样保留。 */
function withRunRecord(
  record: EnvironmentRecord,
  patch: Partial<EnvironmentRunRecord> & { readonly runId: string },
): EnvironmentRecord {
  const previous = record.run;
  if (previous !== undefined && previous.runId === patch.runId)
    return { ...record, run: { ...previous, ...patch } };
  return {
    ...record,
    run: {
      state: "starting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      port: 0,
      address: "",
      privateDirectory: "",
      privateDirectoryIdentity: { device: 0, inode: 0 },
      controlSocket: "",
      launchConfigFile: "",
      productLogFile: "",
      startOperationId: "",
      ...patch,
    } satisfies EnvironmentRunRecord,
  };
}

/**
 * 被取代的陈旧世代只释放本世代自有的秘密与失联控制地址；运行日志随记录长期保留，
 * 确认仍存活时什么都不回收。
 */
async function retireSupersededGeneration(
  record: EnvironmentRecord,
  newRunId: string,
  diagnostics: string[],
): Promise<void> {
  const previous = record.run;
  if (previous === undefined || previous.runId === newRunId) return;
  if (observeLiveness(previous.processIdentity) === "alive") return;
  diagnostics.push(...(await releaseRunSecrets(previous)));
}

function guideEntryPath(): string {
  const current = fileURLToPath(import.meta.url);
  // 源码运行（.ts）与构建产物运行（.js）都交给同目录、同扩展名的外层引导。
  const extension = path.extname(current) === ".ts" ? "ts" : "js";
  return path.join(path.dirname(current), `web-guide.${extension}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 载荷无法核验时没有可信请求，只能按请求阶段失败交出结果。 */
export function startInvalidPayload(message: string): StartOperationResult {
  return simpleResult(
    { kind: "start", workspacePath: process.cwd(), environment: "<invalid>" },
    message,
    "request",
    null,
  );
}

/**
 * 操作内部没有形成结果时的最后兜底：本次不触碰可能已启动的世代，也不宣称收尾完成。
 * 记录里的启动中事实与私有现场都保留，交由查看或后续停止处理。
 */
export function startCrashResult(
  request: StartRequest,
  error: unknown,
): StartOperationResult {
  const layout = createLayout(request.workspacePath, request.environment);
  const message = createDiagnosticRedactor([])(
    `启动操作异常：${describeError(error)}`,
  );
  return {
    kind: "start",
    status: "failed",
    environment:
      "reason" in layout
        ? invalidEnvironmentFacts(request.workspacePath, request.environment)
        : derivedFacts(request, layout),
    run: {
      ...noRunFacts,
      lastFailure: { stage: "operation", message },
    },
    failure: { stage: "operation", message, exitCode: null },
    cleanup: {
      state: "unknown",
      errors: ["启动操作未能完成，无法确认本世代进程状态，保留记录与私有现场"],
    },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}
