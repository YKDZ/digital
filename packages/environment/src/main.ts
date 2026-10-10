import path from "node:path";

import {
  CliWriteError,
  defineCli,
  executeCli,
  helpCapability,
  outputCapability,
  parseCliInvocation,
  text,
  versionCapability,
  type WriteCliOutput,
} from "@ykdz/cli-contract";
import { isNodeBrokenPipe } from "@ykdz/cli-contract/node";
import * as v from "valibot";

import { deleteEnvironment } from "./delete-environment.ts";
import { inspectEnvironment } from "./inspect-environment.ts";
import type {
  EnvironmentState,
  ServiceReadiness,
} from "./inspect-environment.ts";
import type {
  EnvironmentRunFacts,
  LifecycleCleanup,
  ProcessLiveness,
} from "./internal/operation-contract.ts";
import { findRepositoryWorkspace } from "./internal/paths.ts";
import type { JsonValue, RecordedOperationOutcome } from "./internal/record.ts";
import {
  prepareEnvironment,
  type EnvironmentFacts,
  type PrepareCleanup,
  type PrepareLogs,
} from "./prepare-environment.ts";
import { rebuildEnvironment } from "./rebuild-environment.ts";
import { standardSchema } from "./standard-schema.ts";
import { startEnvironment } from "./start-environment.ts";
import { stopEnvironment } from "./stop-environment.ts";

export type EnvironmentCliRuntime = {
  readonly argv: readonly string[];
  readonly version: string;
  readonly cwd: string;
  readonly write: WriteCliOutput;
};

type CliDependencies = {
  readonly getManifest: () => Record<string, unknown>;
  readonly cwd: string;
};

const cleanupSchema = v.object({
  state: v.picklist(["not-started", "stopped", "unknown"]),
  errors: v.array(v.string()),
});

const logsSchema = v.object({
  directory: v.nullable(v.string()),
  files: v.array(v.string()),
});

const factsSchema = v.object({
  workspacePath: v.string(),
  environment: v.string(),
  environmentId: v.nullable(v.string()),
  containerDirectory: v.string(),
  productDataRoot: v.string(),
  inputs: v.array(v.string()),
  sourceMode: v.string(),
  config: v.record(v.string(), v.unknown()),
  dataGeneration: v.nullable(v.string()),
});

const lifecycleCleanupSchema = v.object({
  state: v.picklist(["not-started", "stopped", "unknown", "released"]),
  errors: v.array(v.string()),
});

const runFactsSchema = v.object({
  runId: v.nullable(v.string()),
  state: v.picklist(["absent", "starting", "ready", "stopping", "stopped"]),
  address: v.nullable(v.string()),
  port: v.nullable(v.number()),
  productLogFile: v.nullable(v.string()),
  logHealth: v.nullable(
    v.picklist(["recording", "complete", "incomplete", "unknown"]),
  ),
  pid: v.nullable(v.number()),
  processLiveness: v.picklist(["alive", "exited", "unknown", "absent"]),
  controlReachable: v.boolean(),
  serviceReady: v.nullable(v.boolean()),
  startedAt: v.nullable(v.string()),
  updatedAt: v.nullable(v.string()),
  endedAt: v.nullable(v.string()),
  lastFailure: v.optional(v.object({ stage: v.string(), message: v.string() })),
});

const startFailureSchema = v.object({
  stage: v.picklist([
    "request",
    "claim",
    "generation",
    "artifacts",
    "port",
    "intent",
    "spawn",
    "handshake",
    "ready",
    "operation",
  ]),
  message: v.string(),
  exitCode: v.nullable(v.number()),
});

const stopFailureSchema = v.object({
  stage: v.picklist(["request", "claim", "generation", "control", "operation"]),
  message: v.string(),
  exitCode: v.nullable(v.number()),
});

const rebuildFailureSchema = v.object({
  stage: v.picklist([
    "request",
    "claim",
    "generation",
    "intent",
    "offline",
    "purge",
    "build",
    "migrate",
    "read",
    "operation",
  ]),
  message: v.string(),
  exitCode: v.nullable(v.number()),
});

const deleteFailureSchema = v.object({
  stage: v.picklist([
    "request",
    "claim",
    "generation",
    "intent",
    "offline",
    "purge",
    "operation",
  ]),
  message: v.string(),
  exitCode: v.nullable(v.number()),
});

/** 结果事实按 JSON 投影复制为可变结构，只读列表留在接口层。 */
const factsPayload = (facts: EnvironmentFacts) => ({
  ...facts,
  inputs: [...facts.inputs],
  config: { ...facts.config },
});

const cleanupPayload = (cleanup: PrepareCleanup) => ({
  state: cleanup.state,
  errors: [...cleanup.errors],
});

const lifecycleCleanupPayload = (cleanup: LifecycleCleanup) => ({
  state: cleanup.state,
  errors: [...cleanup.errors],
});

const runPayload = (run: EnvironmentRunFacts) => ({ ...run });

const logsPayload = (logs: PrepareLogs) => ({
  directory: logs.directory,
  files: [...logs.files],
});

/** 单行文本投影不允许换行符；诊断与原因都先压成一行。 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

const stateLabels: Record<EnvironmentState, string> = {
  unprepared: "未准备",
  preparing: "准备中",
  prepared: "已准备",
  failed: "准备失败",
  "config-incompatible": "配置不兼容",
  unmanaged: "未被接管",
};

const runStateLabels: Record<EnvironmentRunFacts["state"], string> = {
  absent: "没有受管理的世代",
  starting: "启动中",
  ready: "已就绪",
  stopping: "关闭中",
  stopped: "已停止",
};

const livenessLabels: Record<ProcessLiveness, string> = {
  alive: "进程存活",
  exited: "进程已退出",
  unknown: "无法确认进程状态",
  absent: "没有进程身份",
};

const readinessLabels: Record<ServiceReadiness, string> = {
  "not-evaluated": "未评估（该记录没有受管理的世代）",
  ready: "已就绪（控制认证与真实 ready 签名同时成立）",
  "not-ready": "未就绪",
  unknown: "无法确认",
};

const operationOutcomeLabels: Record<RecordedOperationOutcome, string> = {
  prepared: "已准备",
  ready: "已就绪",
  "already-ready": "沿用已就绪世代",
  stopped: "已停止",
  "already-stopped": "本已停止",
  failed: "失败",
  refused: "被拒绝",
  "not-confirmed": "未确认退出",
  interrupted: "被后续操作收编",
  rebuilt: "已重建",
  deleted: "已删除",
  "already-deleted": "本已删除",
};

/** 文本查看给出最近一次操作的日志位置；未结束的操作如实标出进行中。 */
type OperationLogPointer = {
  readonly outcome?: RecordedOperationOutcome | undefined;
  readonly logDirectory: string;
};

function describeOperations(
  operations: readonly OperationLogPointer[] | undefined,
): string {
  const last = operations?.at(-1);
  if (operations === undefined || last === undefined)
    return "操作日志：该环境还没有操作记录";
  const outcome =
    last.outcome === undefined
      ? "进行中"
      : operationOutcomeLabels[last.outcome];
  return `最近操作日志（${operations.length} 次操作，本次${outcome}）：${last.logDirectory}`;
}

function describeLogs(logs: { directory: string | null }): string {
  return logs.directory === null
    ? "本次没有留下操作日志"
    : `操作日志：${logs.directory}`;
}

/** 运行世代一行：标识、记录状态与本次观察到的进程状态。 */
function describeRun(
  run: Pick<EnvironmentRunFacts, "runId" | "state" | "processLiveness" | "pid">,
): string {
  return `世代 ${run.runId ?? "未知"}（${runStateLabels[run.state]}，${
    livenessLabels[run.processLiveness]
  }${run.pid === null ? "" : `，PID ${String(run.pid)}`}）`;
}

function createCliContract(version: string) {
  const define = defineCli<CliDependencies>();
  return define({
    root: "environment",
    help: helpCapability({
      shortAlias: "-h",
      headings: {
        usage: "用法",
        commands: "命令",
        arguments: "参数",
        options: "选项",
        supplement: "说明",
      },
      wording: {
        commandPlaceholder: "命令",
        choices: "候选：{choices}",
        default: "默认：{value}",
      },
    }),
    version: versionCapability({
      value: text.line(`digital-environment ${version}`),
      shortAlias: "-V",
    }),
    output: outputCapability({ defaultFormat: "structured", text: true }),
    usageFailureExitCode: 2,
    commands: {
      environment: {
        kind: "rootGroup",
        name: "digital-environment",
        description: "Digital 运行环境管理。",
        helpSupplement: text.lines([
          "prepare 建立或核验一个可被产品使用的环境；start 启动该环境的真实产品 Web 服务；",
          "stop 只停止本记录管理的世代；inspect 只读查看状态、归属与日志位置。",
          "rebuild 把已停止的所选环境按原配置重建为初态；delete 回收该环境自有的记录、",
          "数据、日志与私有运行现场。两者都拒绝在运行中或收尾未确认时改动，也不触碰",
          "原始素材、其他环境和工作区管理级锁文件。",
          "就绪只由私有控制认证与真实 ready 签名决定；停止保留产品数据、配置与日志。",
          "prepare 与 start 可用 --timeout-ms 约定本次操作期限；期限到期或收到 SIGINT/SIGTERM 只取消本次操作，取消之后仍完成自有资源收尾，被取消的操作按失败退出。",
          "已经成功就绪并发布的世代归产品自己持有：之后再对无关命令发出信号不会停止该服务。",
          "退出码：0 成功；1 操作失败；2 用法错误；3 配置不兼容；4 归属不可接管；5 请求无效。",
        ]),
      },
      ...define.command("prepare")({
        kind: "command",
        parent: "environment",
        name: "prepare",
        description: "为选定环境构建交付目标、执行正式迁移并核验产品读取。",
        input: standardSchema(
          v.object({
            environment: v.pipe(v.string(), v.minLength(1)),
            workspace: v.optional(v.pipe(v.string(), v.minLength(1))),
            input: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
            sourceMode: v.optional(v.pipe(v.string(), v.minLength(1))),
            configJson: v.optional(v.string()),
            timeoutMs: v.optional(v.pipe(v.string(), v.minLength(1))),
          }),
        ),
        fields: {
          environment: {
            kind: "valueOption",
            longOption: "--environment",
            description: "环境名。",
          },
          workspace: {
            kind: "valueOption",
            longOption: "--workspace-path",
            description: "工作区路径；默认为当前目录。",
          },
          input: {
            kind: "repeatableOption",
            longOption: "--input",
            description: "普通素材目录，可重复指定。",
          },
          sourceMode: {
            kind: "valueOption",
            longOption: "--source-mode",
            description:
              "来源模式：offline（缺省）、controlled 或 real；controlled 需要在配置里给出 sourceIo 清单路径与内容身份。",
          },
          configJson: {
            kind: "valueOption",
            longOption: "--config-json",
            description: "非秘密运行配置的 JSON 对象。",
          },
          timeoutMs: {
            kind: "valueOption",
            longOption: "--timeout-ms",
            description:
              "本次操作的期限毫秒数；到期后取消本次操作并收尾自有资源。",
          },
        },
        success: {
          kind: "data",
          variants: {
            prepared: {
              description: "环境已准备，产品读取已核验",
              exitCode: 0,
              schema: standardSchema(
                v.object({
                  status: v.literal("prepared"),
                  environment: factsSchema,
                  cleanup: cleanupSchema,
                  logs: logsSchema,
                  interruptedOperationIds: v.array(v.string()),
                  diagnostics: v.array(v.string()),
                }),
              ),
              text: ({ environment, logs, diagnostics }) =>
                text.lines([
                  `环境 ${environment.environment} 已准备（不代表服务就绪）。`,
                  `产品数据根：${environment.productDataRoot}`,
                  oneLine(describeLogs(logs)),
                  ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
                ]),
            },
          },
        },
        failures: {
          failed: {
            description: "准备在当前阶段失败，现场与日志已保留",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                status: v.literal("failed"),
                environment: factsSchema,
                failure: v.object({
                  stage: v.string(),
                  message: v.string(),
                  exitCode: v.nullable(v.number()),
                }),
                cleanup: cleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure, logs, cleanup, diagnostics }) =>
              text.lines([
                `准备失败（阶段 ${failure.stage}）：${oneLine(failure.message)}`,
                oneLine(describeLogs(logs)),
                `子进程收尾：${cleanup.state}`,
                ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
              ]),
          },
          configIncompatible: {
            description: "请求与已准备记录不一致，原状态已保留",
            exitCode: 3,
            schema: standardSchema(
              v.object({
                status: v.literal("config-incompatible"),
                environment: factsSchema,
                differences: v.array(v.string()),
                failure: v.object({
                  stage: v.string(),
                  message: v.string(),
                  exitCode: v.nullable(v.number()),
                }),
              }),
            ),
            text: ({ differences, environment }) =>
              text.lines([
                `配置与已准备记录不兼容：${differences.join("、")}。`,
                `保留环境 ${environment.environment} 的原状态，不隐式清空。`,
              ]),
          },
          unmanaged: {
            description: "目标容器不属于本管理器，未做任何改动",
            exitCode: 4,
            schema: standardSchema(
              v.object({
                status: v.literal("unmanaged"),
                environment: factsSchema,
                failure: v.object({
                  stage: v.string(),
                  message: v.string(),
                  exitCode: v.nullable(v.number()),
                }),
              }),
            ),
            text: ({ failure }) =>
              text.line(`拒绝接管该目录：${oneLine(failure.message)}`),
          },
          invalidRequest: {
            description: "请求本身无效，未开始任何操作",
            exitCode: 5,
            schema: standardSchema(
              v.object({
                status: v.literal("invalid-request"),
                reason: v.string(),
              }),
            ),
            text: ({ reason }) => text.line(`请求无效：${oneLine(reason)}`),
          },
        },
        handler: async ({ dependencies, input, outcome }) => {
          const config = parseConfigJson(input.configJson);
          if ("reason" in config)
            return outcome.failure.invalidRequest({
              status: "invalid-request",
              reason: config.reason,
            });
          const timeout = parseTimeoutMs(input.timeoutMs);
          if ("reason" in timeout)
            return outcome.failure.invalidRequest({
              status: "invalid-request",
              reason: timeout.reason,
            });
          const result = await withCancellation((signal) =>
            prepareEnvironment({
              workspacePath: selectedWorkspace(
                dependencies.cwd,
                input.workspace,
              ),
              environment: input.environment,
              inputs: (input.input ?? []).map((item) =>
                path.resolve(dependencies.cwd, item),
              ),
              sourceMode: input.sourceMode ?? "offline",
              config: config.value,
              signal,
              timeoutMs: timeout.value,
            }),
          );
          switch (result.status) {
            case "prepared":
              return outcome.data.prepared({
                status: "prepared",
                environment: factsPayload(result.environment),
                cleanup: cleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                interruptedOperationIds: [
                  ...(result.interruptedOperationIds ?? []),
                ],
                diagnostics: [...result.diagnostics],
              });
            case "config-incompatible":
              return outcome.failure.configIncompatible({
                status: "config-incompatible",
                environment: factsPayload(result.environment),
                differences: [...(result.incompatibility ?? [])],
                failure: requiredFailure(result),
              });
            case "unmanaged":
              return outcome.failure.unmanaged({
                status: "unmanaged",
                environment: factsPayload(result.environment),
                failure: requiredFailure(result),
              });
            case "invalid-request":
              return outcome.failure.invalidRequest({
                status: "invalid-request",
                reason: requiredFailure(result).message,
              });
            default:
              return outcome.failure.failed({
                status: "failed",
                environment: factsPayload(result.environment),
                failure: requiredFailure(result),
                cleanup: cleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
          }
        },
      }),
      ...define.command("start")({
        kind: "command",
        parent: "environment",
        name: "start",
        description: "启动已准备环境的真实产品 Web 服务，并确认真实就绪。",
        input: standardSchema(
          v.object({
            environment: v.pipe(v.string(), v.minLength(1)),
            workspace: v.optional(v.pipe(v.string(), v.minLength(1))),
            timeoutMs: v.optional(v.pipe(v.string(), v.minLength(1))),
          }),
        ),
        fields: {
          environment: {
            kind: "valueOption",
            longOption: "--environment",
            description: "环境名。",
          },
          workspace: {
            kind: "valueOption",
            longOption: "--workspace-path",
            description: "工作区路径；默认为当前目录。",
          },
          timeoutMs: {
            kind: "valueOption",
            longOption: "--timeout-ms",
            description:
              "本次启动的期限毫秒数；到期或收到终止信号时只取消本世代发布之前的等待并收尾自有进程。",
          },
        },
        success: {
          kind: "data",
          variants: {
            ready: {
              description: "本世代已通过控制认证与真实就绪签名",
              exitCode: 0,
              schema: standardSchema(
                v.object({
                  status: v.literal("ready"),
                  environment: factsSchema,
                  run: runFactsSchema,
                  cleanup: lifecycleCleanupSchema,
                  logs: logsSchema,
                  diagnostics: v.array(v.string()),
                }),
              ),
              text: ({ run, logs, diagnostics }) =>
                text.lines([
                  `服务已就绪：${run.address ?? "地址未知"}`,
                  describeRun(run),
                  `产品日志：${run.productLogFile ?? "未知"}（健康 ${
                    run.logHealth ?? "unknown"
                  }）`,
                  oneLine(describeLogs(logs)),
                  ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
                ]),
            },
            alreadyReady: {
              description: "同一世代已就绪，未创建第二个进程",
              exitCode: 0,
              schema: standardSchema(
                v.object({
                  status: v.literal("already-ready"),
                  environment: factsSchema,
                  run: runFactsSchema,
                  cleanup: lifecycleCleanupSchema,
                  logs: logsSchema,
                  diagnostics: v.array(v.string()),
                }),
              ),
              text: ({ run, logs, diagnostics }) =>
                text.lines([
                  `该世代已在提供认证服务，不创建第二个进程：${
                    run.address ?? "地址未知"
                  }`,
                  describeRun(run),
                  `产品日志：${run.productLogFile ?? "未知"}（健康 ${
                    run.logHealth ?? "unknown"
                  }）`,
                  oneLine(describeLogs(logs)),
                  ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
                ]),
            },
          },
        },
        failures: {
          failed: {
            description: "启动在当前阶段失败，现场与日志已保留",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                status: v.literal("failed"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: startFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure, run, logs, cleanup, diagnostics }) =>
              text.lines([
                `启动失败（阶段 ${failure.stage}）：${oneLine(failure.message)}`,
                describeRun(run),
                oneLine(describeLogs(logs)),
                `本次自持资源收尾：${cleanup.state}`,
                ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
              ]),
          },
          refused: {
            description: "既有世代状态无法确认，未启动第二个服务",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                status: v.literal("refused"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: startFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure, run }) =>
              text.lines([
                `拒绝启动：${oneLine(failure.message)}`,
                describeRun(run),
              ]),
          },
          unmanaged: {
            description: "目标容器不属于本管理器，未做任何改动",
            exitCode: 4,
            schema: standardSchema(
              v.object({
                status: v.literal("unmanaged"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: startFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure }) =>
              text.line(`拒绝接管该目录：${oneLine(failure.message)}`),
          },
          invalidRequest: {
            description: "启动请求本身无效，未开始任何操作",
            exitCode: 5,
            schema: standardSchema(
              v.object({
                status: v.literal("invalid-request"),
                reason: v.string(),
              }),
            ),
            text: ({ reason }) => text.line(`请求无效：${oneLine(reason)}`),
          },
        },
        handler: async ({ dependencies, input, outcome }) => {
          const timeout = parseTimeoutMs(input.timeoutMs);
          if ("reason" in timeout)
            return outcome.failure.invalidRequest({
              status: "invalid-request",
              reason: timeout.reason,
            });
          const result = await withCancellation((signal) =>
            startEnvironment({
              workspacePath: selectedWorkspace(
                dependencies.cwd,
                input.workspace,
              ),
              environment: input.environment,
              signal,
              timeoutMs: timeout.value,
            }),
          );
          switch (result.status) {
            case "ready":
              return outcome.data.ready({
                status: "ready",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "already-ready":
              return outcome.data.alreadyReady({
                status: "already-ready",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "refused":
              return outcome.failure.refused({
                status: "refused",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "operation",
                  message: "启动被拒绝但没有交出具体的阶段说明",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "unmanaged":
              return outcome.failure.unmanaged({
                status: "unmanaged",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "claim",
                  message: "归属无法确认为本管理器自有",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "invalid-request":
              return outcome.failure.invalidRequest({
                status: "invalid-request",
                reason: requiredFailure(result).message,
              });
            default:
              return outcome.failure.failed({
                status: "failed",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "operation",
                  message: "启动未交出具体的失败说明",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
          }
        },
      }),
      ...define.command("stop")({
        kind: "command",
        parent: "environment",
        name: "stop",
        description: "停止本记录管理的运行世代，保留产品数据与日志。",
        input: standardSchema(
          v.object({
            environment: v.pipe(v.string(), v.minLength(1)),
            workspace: v.optional(v.pipe(v.string(), v.minLength(1))),
          }),
        ),
        fields: {
          environment: {
            kind: "valueOption",
            longOption: "--environment",
            description: "环境名。",
          },
          workspace: {
            kind: "valueOption",
            longOption: "--workspace-path",
            description: "工作区路径；默认为当前目录。",
          },
        },
        success: {
          kind: "data",
          variants: {
            stopped: {
              description: "本世代已确认退出，数据与日志保留",
              exitCode: 0,
              schema: standardSchema(
                v.object({
                  status: v.literal("stopped"),
                  environment: factsSchema,
                  run: runFactsSchema,
                  cleanup: lifecycleCleanupSchema,
                  logs: logsSchema,
                  diagnostics: v.array(v.string()),
                }),
              ),
              text: ({ run, logs, diagnostics }) =>
                text.lines([
                  `本世代已确认退出：${oneLine(describeRun(run))}`,
                  `产品数据、配置与运行日志都已保留：${run.productLogFile ?? "日志未知"}`,
                  oneLine(describeLogs(logs)),
                  ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
                ]),
            },
            alreadyStopped: {
              description: "没有需要停止的受管世代，状态与实际一致",
              exitCode: 0,
              schema: standardSchema(
                v.object({
                  status: v.literal("already-stopped"),
                  environment: factsSchema,
                  run: runFactsSchema,
                  cleanup: lifecycleCleanupSchema,
                  logs: logsSchema,
                  diagnostics: v.array(v.string()),
                }),
              ),
              text: ({ environment, run, logs, diagnostics }) =>
                text.lines([
                  `环境 ${environment.environment} 没有需要停止的受管世代。`,
                  describeRun(run),
                  oneLine(describeLogs(logs)),
                  ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
                ]),
            },
          },
        },
        failures: {
          notConfirmed: {
            description: "无法确认本世代退出，已保留现场允许再次停止",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                status: v.literal("not-confirmed"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: stopFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure, run, logs, cleanup }) =>
              text.lines([
                `未能确认退出：${oneLine(failure.message)}`,
                describeRun(run),
                oneLine(describeLogs(logs)),
                `收尾：${cleanup.state}`,
                ...cleanup.errors.map((item) => `收尾未了：${oneLine(item)}`),
              ]),
          },
          unmanaged: {
            description: "目标容器或记录不属于本管理器，未做任何改动",
            exitCode: 4,
            schema: standardSchema(
              v.object({
                status: v.literal("unmanaged"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: stopFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure }) =>
              text.line(`拒绝接管该目录：${oneLine(failure.message)}`),
          },
          invalidRequest: {
            description: "停止请求本身无效，未开始任何操作",
            exitCode: 5,
            schema: standardSchema(
              v.object({
                status: v.literal("invalid-request"),
                reason: v.string(),
              }),
            ),
            text: ({ reason }) => text.line(`请求无效：${oneLine(reason)}`),
          },
        },
        handler: async ({ dependencies, input, outcome }) => {
          const result = await stopEnvironment({
            workspacePath: selectedWorkspace(dependencies.cwd, input.workspace),
            environment: input.environment,
          });
          switch (result.status) {
            case "stopped":
              return outcome.data.stopped({
                status: "stopped",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "already-stopped":
              return outcome.data.alreadyStopped({
                status: "already-stopped",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "unmanaged":
              return outcome.failure.unmanaged({
                status: "unmanaged",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "claim",
                  message: "归属无法确认为本管理器自有",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "invalid-request":
              return outcome.failure.invalidRequest({
                status: "invalid-request",
                reason: requiredFailure(result).message,
              });
            default:
              return outcome.failure.notConfirmed({
                status: "not-confirmed",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "operation",
                  message: "停止未交出具体的失败说明",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
          }
        },
      }),
      ...define.command("rebuild")({
        kind: "command",
        parent: "environment",
        name: "rebuild",
        description:
          "把已停止的所选环境按原配置重建为初态，回收其自有产品数据。",
        input: standardSchema(
          v.object({
            environment: v.pipe(v.string(), v.minLength(1)),
            workspace: v.optional(v.pipe(v.string(), v.minLength(1))),
          }),
        ),
        fields: {
          environment: {
            kind: "valueOption",
            longOption: "--environment",
            description: "环境名。",
          },
          workspace: {
            kind: "valueOption",
            longOption: "--workspace-path",
            description: "工作区路径；默认为当前目录。",
          },
        },
        success: {
          kind: "data",
          variants: {
            rebuilt: {
              description:
                "已从空数据根完成正式构建、迁移与读取并发布新数据世代",
              exitCode: 0,
              schema: standardSchema(
                v.object({
                  status: v.literal("rebuilt"),
                  environment: factsSchema,
                  run: runFactsSchema,
                  cleanup: lifecycleCleanupSchema,
                  logs: logsSchema,
                  diagnostics: v.array(v.string()),
                }),
              ),
              text: ({ environment, run, logs, diagnostics }) =>
                text.lines([
                  `环境 ${environment.environment} 已重建为初态（数据世代 ${
                    environment.dataGeneration ?? "未知"
                  }），已准备但不代表服务就绪。`,
                  `保留的输入目录：${
                    environment.inputs.length === 0
                      ? "无"
                      : environment.inputs.join("、")
                  }`,
                  `产品数据根：${environment.productDataRoot}`,
                  describeRun(run),
                  oneLine(describeLogs(logs)),
                  ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
                ]),
            },
          },
        },
        failures: {
          refused: {
            description: "世代状态或意图未收敛，拒绝改动任何保留内容",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                status: v.literal("refused"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: rebuildFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure, run, logs }) =>
              text.lines([
                `拒绝重建：${oneLine(failure.message)}`,
                describeRun(run),
                oneLine(describeLogs(logs)),
                "该环境的记录、产品数据与配置都保持原样。",
              ]),
          },
          failed: {
            description: "重建在当前阶段失败，现场与日志已保留",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                status: v.literal("failed"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: rebuildFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure, logs, cleanup, diagnostics }) =>
              text.lines([
                `重建失败（阶段 ${failure.stage}）：${oneLine(failure.message)}`,
                oneLine(describeLogs(logs)),
                `本次自持资源收尾：${cleanup.state}`,
                ...cleanup.errors.map((item) => `收尾未了：${oneLine(item)}`),
                ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
              ]),
          },
          notConfirmed: {
            description: "重建的破坏性改动未能确认收敛，意图与现场已保留",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                status: v.literal("not-confirmed"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: rebuildFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure, logs, cleanup }) =>
              text.lines([
                `重建未确认收敛：${oneLine(failure.message)}`,
                oneLine(describeLogs(logs)),
                `本次自持资源收尾：${cleanup.state}`,
                "重建意图已保留，可再次执行 rebuild 按同一意图继续收敛。",
              ]),
          },
          unmanaged: {
            description: "目标容器或记录不属于本管理器，未做任何改动",
            exitCode: 4,
            schema: standardSchema(
              v.object({
                status: v.literal("unmanaged"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: rebuildFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure }) =>
              text.line(`拒绝接管该目录：${oneLine(failure.message)}`),
          },
          invalidRequest: {
            description: "重建请求本身无效，未开始任何操作",
            exitCode: 5,
            schema: standardSchema(
              v.object({
                status: v.literal("invalid-request"),
                reason: v.string(),
              }),
            ),
            text: ({ reason }) => text.line(`请求无效：${oneLine(reason)}`),
          },
        },
        handler: async ({ dependencies, input, outcome }) => {
          const result = await rebuildEnvironment({
            workspacePath: selectedWorkspace(dependencies.cwd, input.workspace),
            environment: input.environment,
          });
          switch (result.status) {
            case "rebuilt":
              return outcome.data.rebuilt({
                status: "rebuilt",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "refused":
              return outcome.failure.refused({
                status: "refused",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "generation",
                  message: "重建被拒绝但没有交出具体的阶段说明",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "unmanaged":
              return outcome.failure.unmanaged({
                status: "unmanaged",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "claim",
                  message: "归属无法确认为本管理器自有",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "not-confirmed":
              return outcome.failure.notConfirmed({
                status: "not-confirmed",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "operation",
                  message: "重建未能确认收敛，也没有交出具体的阶段说明",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "invalid-request":
              return outcome.failure.invalidRequest({
                status: "invalid-request",
                reason: requiredFailure(result).message,
              });
            default:
              return outcome.failure.failed({
                status: "failed",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "operation",
                  message: "重建未交出具体的失败说明",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
          }
        },
      }),
      ...define.command("delete")({
        kind: "command",
        parent: "environment",
        name: "delete",
        description: "删除已停止的所选环境自有的记录、数据、日志与运行现场。",
        input: standardSchema(
          v.object({
            environment: v.pipe(v.string(), v.minLength(1)),
            workspace: v.optional(v.pipe(v.string(), v.minLength(1))),
          }),
        ),
        fields: {
          environment: {
            kind: "valueOption",
            longOption: "--environment",
            description: "环境名。",
          },
          workspace: {
            kind: "valueOption",
            longOption: "--workspace-path",
            description: "工作区路径；默认为当前目录。",
          },
        },
        success: {
          kind: "data",
          variants: {
            deleted: {
              description: "该环境自有的记录、数据、日志与私有运行现场已回收",
              exitCode: 0,
              schema: standardSchema(
                v.object({
                  status: v.literal("deleted"),
                  environment: factsSchema,
                  run: runFactsSchema,
                  cleanup: lifecycleCleanupSchema,
                  logs: logsSchema,
                  diagnostics: v.array(v.string()),
                }),
              ),
              text: ({ environment, run, cleanup, diagnostics }) =>
                text.lines([
                  `环境 ${environment.environment} 已删除：其自有记录、产品数据、日志与私有运行现场已回收。`,
                  `被回收的产品数据根：${environment.productDataRoot}`,
                  describeRun(run),
                  `本次自持资源收尾：${cleanup.state}`,
                  "原始素材、其他环境与工作区管理级锁文件未被触碰。",
                  ...cleanup.errors.map((item) => `收尾未了：${oneLine(item)}`),
                  ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
                ]),
            },
            alreadyDeleted: {
              description: "该环境没有受管理的记录与自有资源，删除结论明确",
              exitCode: 0,
              schema: standardSchema(
                v.object({
                  status: v.literal("already-deleted"),
                  environment: factsSchema,
                  run: runFactsSchema,
                  cleanup: lifecycleCleanupSchema,
                  logs: logsSchema,
                  diagnostics: v.array(v.string()),
                }),
              ),
              text: ({ environment, diagnostics }) =>
                text.lines([
                  `环境 ${environment.environment} 没有受本管理器记录的自有资源，已按删除处理。`,
                  `容器位置：${environment.containerDirectory}`,
                  ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
                ]),
            },
          },
        },
        failures: {
          refused: {
            description: "世代仍在运行或收尾未确认，拒绝破坏并要求先独立停止",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                status: v.literal("refused"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: deleteFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure, run, logs }) =>
              text.lines([
                `拒绝删除：${oneLine(failure.message)}`,
                describeRun(run),
                oneLine(describeLogs(logs)),
                "该环境的记录、产品数据与日志都保持原样。",
              ]),
          },
          failed: {
            description: "删除在当前阶段失败，未做任何破坏性改动",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                status: v.literal("failed"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: deleteFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure, logs, diagnostics }) =>
              text.lines([
                `删除失败（阶段 ${failure.stage}）：${oneLine(failure.message)}`,
                oneLine(describeLogs(logs)),
                ...diagnostics.map((item) => `额外诊断：${oneLine(item)}`),
              ]),
          },
          notConfirmed: {
            description: "自有资源未能确认全部回收，删除意图与残余现场已保留",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                status: v.literal("not-confirmed"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: deleteFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure, logs, cleanup }) =>
              text.lines([
                `删除未确认收敛：${oneLine(failure.message)}`,
                oneLine(describeLogs(logs)),
                `本次自持资源收尾：${cleanup.state}`,
                "删除意图已保留，可再次执行 delete 收敛残余自有资源。",
              ]),
          },
          unmanaged: {
            description: "目标容器或记录不属于本管理器，未做任何改动",
            exitCode: 4,
            schema: standardSchema(
              v.object({
                status: v.literal("unmanaged"),
                environment: factsSchema,
                run: runFactsSchema,
                failure: deleteFailureSchema,
                cleanup: lifecycleCleanupSchema,
                logs: logsSchema,
                diagnostics: v.array(v.string()),
              }),
            ),
            text: ({ failure }) =>
              text.line(`拒绝删除未接管的内容：${oneLine(failure.message)}`),
          },
          invalidRequest: {
            description: "删除请求本身无效，未开始任何操作",
            exitCode: 5,
            schema: standardSchema(
              v.object({
                status: v.literal("invalid-request"),
                reason: v.string(),
              }),
            ),
            text: ({ reason }) => text.line(`请求无效：${oneLine(reason)}`),
          },
        },
        handler: async ({ dependencies, input, outcome }) => {
          const result = await deleteEnvironment({
            workspacePath: selectedWorkspace(dependencies.cwd, input.workspace),
            environment: input.environment,
          });
          switch (result.status) {
            case "deleted":
              return outcome.data.deleted({
                status: "deleted",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "already-deleted":
              return outcome.data.alreadyDeleted({
                status: "already-deleted",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "refused":
              return outcome.failure.refused({
                status: "refused",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "generation",
                  message: "删除被拒绝但没有交出具体的阶段说明",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "unmanaged":
              return outcome.failure.unmanaged({
                status: "unmanaged",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "claim",
                  message: "归属无法确认为本管理器自有",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "not-confirmed":
              return outcome.failure.notConfirmed({
                status: "not-confirmed",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "operation",
                  message: "删除未能确认收敛，也没有交出具体的阶段说明",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
            case "invalid-request":
              return outcome.failure.invalidRequest({
                status: "invalid-request",
                reason: requiredFailure(result).message,
              });
            default:
              return outcome.failure.failed({
                status: "failed",
                environment: factsPayload(result.environment),
                run: runPayload(result.run),
                failure: result.failure ?? {
                  stage: "operation",
                  message: "删除未交出具体的失败说明",
                  exitCode: null,
                },
                cleanup: lifecycleCleanupPayload(result.cleanup),
                logs: logsPayload(result.logs),
                diagnostics: [...result.diagnostics],
              });
          }
        },
      }),
      ...define.command("inspect")({
        kind: "command",
        parent: "environment",
        name: "inspect",
        description: "只读查看所选环境的准备状态、归属、运行世代与日志位置。",
        input: standardSchema(
          v.object({
            environment: v.pipe(v.string(), v.minLength(1)),
            workspace: v.optional(v.pipe(v.string(), v.minLength(1))),
          }),
        ),
        fields: {
          environment: {
            kind: "valueOption",
            longOption: "--environment",
            description: "环境名。",
          },
          workspace: {
            kind: "valueOption",
            longOption: "--workspace-path",
            description: "工作区路径；默认为当前目录。",
          },
        },
        success: {
          kind: "data",
          variants: {
            inspection: {
              description: "所选环境的只读观察结果",
              exitCode: 0,
              schema: standardSchema(
                v.object({
                  status: v.literal("ok"),
                  state: v.picklist([
                    "unprepared",
                    "preparing",
                    "prepared",
                    "failed",
                    "config-incompatible",
                    "unmanaged",
                  ]),
                  environment: factsSchema,
                  reason: v.optional(v.string()),
                  preparation: v.optional(
                    v.object({
                      updatedAt: v.string(),
                      lastOperationId: v.string(),
                      lastFailure: v.optional(
                        v.object({
                          stage: v.string(),
                          message: v.string(),
                          cleanup: v.picklist(["stopped", "unknown"]),
                        }),
                      ),
                    }),
                  ),
                  operations: v.optional(
                    v.array(
                      v.object({
                        id: v.string(),
                        kind: v.picklist([
                          "prepare",
                          "start",
                          "stop",
                          "rebuild",
                          "delete",
                        ]),
                        startedAt: v.string(),
                        finishedAt: v.optional(v.string()),
                        outcome: v.optional(
                          v.picklist([
                            "prepared",
                            "ready",
                            "already-ready",
                            "stopped",
                            "already-stopped",
                            "failed",
                            "refused",
                            "not-confirmed",
                            "interrupted",
                            "rebuilt",
                            "deleted",
                            "already-deleted",
                          ]),
                        ),
                        logDirectory: v.string(),
                      }),
                    ),
                  ),
                  pendingIntent: v.optional(
                    v.object({
                      kind: v.picklist(["rebuild", "delete"]),
                      operationId: v.string(),
                      startedAt: v.string(),
                      targetDataGeneration: v.string(),
                    }),
                  ),
                  run: runFactsSchema,
                  runProblem: v.optional(v.string()),
                  serviceReadiness: v.picklist([
                    "not-evaluated",
                    "ready",
                    "not-ready",
                    "unknown",
                  ]),
                }),
              ),
              text: ({
                state,
                environment,
                reason,
                preparation,
                operations,
                pendingIntent,
                run,
                runProblem,
                serviceReadiness,
              }) => {
                const lines = [
                  `环境 ${environment.environment}：${stateLabels[state]}`,
                  `工作区：${environment.workspacePath}`,
                  `产品数据根：${environment.productDataRoot}`,
                  `输入目录：${environment.inputs.length === 0 ? "无" : environment.inputs.join("、")}`,
                  `来源模式：${environment.sourceMode}`,
                  `服务就绪：${readinessLabels[serviceReadiness]}`,
                ];
                if (serviceReadiness !== "not-evaluated") {
                  lines.push(describeRun(run));
                  lines.push(
                    `地址：${run.address ?? "未知"}；运行日志：${
                      run.productLogFile ?? "未知"
                    }（健康 ${run.logHealth ?? "unknown"}）`,
                  );
                }
                lines.push(describeOperations(operations));
                if (pendingIntent !== undefined)
                  lines.push(
                    `未收敛的${
                      pendingIntent.kind === "delete" ? "删除" : "重建"
                    }意图（操作 ${pendingIntent.operationId}，目标数据世代 ${
                      pendingIntent.targetDataGeneration
                    }）：请用显式 ${pendingIntent.kind} 命令继续，未收敛前不启动服务。`,
                  );
                if (reason !== undefined)
                  lines.push(`原因：${oneLine(reason)}`);
                if (runProblem !== undefined)
                  lines.push(`就绪无法确认：${oneLine(runProblem)}`);
                if (preparation?.lastFailure !== undefined)
                  lines.push(
                    `最近准备失败：${preparation.lastFailure.stage} ${oneLine(
                      preparation.lastFailure.message,
                    )}`,
                  );
                if (run.lastFailure !== undefined)
                  lines.push(
                    `最近启动失败：${run.lastFailure.stage} ${oneLine(
                      run.lastFailure.message,
                    )}`,
                  );
                return text.lines(
                  lines.length === 0
                    ? ["环境查看没有可报告内容"]
                    : ([...lines] as [string, ...string[]]),
                );
              },
            },
          },
        },
        failures: {
          invalidRequest: {
            description: "查看请求无效",
            exitCode: 5,
            schema: standardSchema(
              v.object({
                status: v.literal("invalid-request"),
                reason: v.string(),
              }),
            ),
            text: ({ reason }) => text.line(`请求无效：${oneLine(reason)}`),
          },
        },
        handler: async ({ dependencies, input, outcome }) => {
          const result = await inspectEnvironment({
            workspacePath: selectedWorkspace(dependencies.cwd, input.workspace),
            environment: input.environment,
          });
          if (result.status === "invalid-request")
            return outcome.failure.invalidRequest({
              status: "invalid-request",
              reason: result.reason ?? "查看请求无效",
            });
          return outcome.data.inspection({
            status: "ok",
            state: result.state,
            environment: factsPayload(result.environment),
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            ...(result.preparation === undefined
              ? {}
              : { preparation: result.preparation }),
            ...(result.operations === undefined
              ? {}
              : { operations: [...result.operations] }),
            ...(result.pendingIntent === undefined
              ? {}
              : { pendingIntent: { ...result.pendingIntent } }),
            run: runPayload(result.run),
            ...(result.runProblem === undefined
              ? {}
              : { runProblem: result.runProblem }),
            serviceReadiness: result.serviceReadiness,
          });
        },
      }),
      ...define.command("schema")({
        kind: "command",
        parent: "environment",
        name: "schema",
        description: "导出 CLI 契约及输入、输出 Schema。",
        input: standardSchema(v.object({})),
        fields: {},
        success: {
          kind: "data",
          variants: {
            exported: {
              description: "完整 CLI 契约",
              exitCode: 0,
              schema: standardSchema(
                v.object({ manifest: v.record(v.string(), v.unknown()) }),
              ),
              text: ({ manifest }) =>
                text.lines([
                  "CLI 契约",
                  ...JSON.stringify(manifest, null, 2).split("\n"),
                ]),
            },
          },
        },
        failures: {},
        handler: ({ dependencies, outcome }) =>
          outcome.data.exported({ manifest: dependencies.getManifest() }),
      }),
    },
  });
}

function requiredFailure(result: {
  readonly failure?: {
    readonly stage: string;
    readonly message: string;
    readonly exitCode: number | null;
  };
}): { stage: string; message: string; exitCode: number | null } {
  return (
    result.failure ?? {
      stage: "operation",
      message: "操作未交出具体的失败说明",
      exitCode: null,
    }
  );
}

/** CLI 默认当前仓库工作区；显式路径相对调用目录解析。 */
function selectedWorkspace(cwd: string, workspace: string | undefined): string {
  if (workspace !== undefined) return path.resolve(cwd, workspace);
  return findRepositoryWorkspace(cwd) ?? cwd;
}

function parseConfigJson(
  raw: string | undefined,
): { value: { readonly [key: string]: JsonValue } } | { reason: string } {
  if (raw === undefined) return { value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: "运行配置不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { reason: "运行配置必须是 JSON 对象" };
  return { value: parsed as { readonly [key: string]: JsonValue } };
}

/** 期限毫秒数只接受正整数；无法确定语义时直接拒绝，不静默改变调用方约定的界限。 */
function parseTimeoutMs(
  raw: string | undefined,
): { value: number | undefined } | { reason: string } {
  if (raw === undefined) return { value: undefined };
  if (!/^\d+$/u.test(raw)) return { reason: "操作期限必须是正整数毫秒数" };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    return { reason: "操作期限必须是正整数毫秒数" };
  return { value };
}

/**
 * 会取消的操作命令才接住终止信号：命令执行期间收到的 SIGINT/SIGTERM 换成一次取消，
 * 由持锁操作进程完成自有资源收尾后按失败退出。命令一结束就撤除监听，只读命令与其它
 * 调用保持终端默认行为。
 */
function holdCancellation(): {
  readonly signal: AbortSignal;
  readonly release: () => void;
} {
  const controller = new AbortController();
  const entries: readonly [NodeJS.Signals, () => void][] = (
    ["SIGINT", "SIGTERM"] as const
  ).map((signal) => [
    signal,
    () => {
      if (!controller.signal.aborted) controller.abort(signal);
    },
  ]);
  for (const [signal, listener] of entries) process.on(signal, listener);
  return {
    signal: controller.signal,
    release: () => {
      for (const [signal, listener] of entries)
        process.removeListener(signal, listener);
    },
  };
}

/** 只在一次可取消操作的执行期间持有取消条件。 */
async function withCancellation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const cancellation = holdCancellation();
  try {
    return await operation(cancellation.signal);
  } finally {
    cancellation.release();
  }
}

export async function runEnvironmentCli(
  runtime: EnvironmentCliRuntime,
): Promise<number> {
  try {
    const contract = createCliContract(runtime.version);
    const result = await executeCli(contract, {
      invocation: parseCliInvocation(contract, runtime.argv.slice(2)),
      dependencies: {
        getManifest: () => ({ ...contract.manifest }),
        cwd: runtime.cwd,
      },
      write: runtime.write,
    });
    return result.exitCode;
  } catch (error) {
    if (
      error instanceof CliWriteError &&
      error.destination === "stdout" &&
      isNodeBrokenPipe(error)
    )
      return 0;
    try {
      await runtime.write({
        destination: "stderr",
        chunk: "命令执行失败；请检查运行环境或报告此问题。\n",
      });
    } catch {
      // 诊断通道故障不能改变原定退出类别。
    }
    return 70;
  }
}
