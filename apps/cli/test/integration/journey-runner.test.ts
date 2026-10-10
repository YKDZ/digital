import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  stubDeletion,
  stubRecycling,
  stubScenarioEnvironment,
  type OwnedRecycling,
  type AcceptanceEnvironment,
} from "../e2e/environment-runtime.ts";
import type { CliJourney } from "../e2e/journey.ts";
import {
  assertHaltedJourneyCommand,
  formatJourneyAssertionFailure,
  redactJourneyDiagnostic,
  runJourney,
  type JourneyEnvironmentLifecycle,
} from "../e2e/run-journeys.ts";

/**
 * 单元层不重复支付真实环境准备：只核验调用方的归属与收尾分支。真实环境包的公开
 * 接口由 test/integration/environment-ownership.test.ts 覆盖。
 */
type UnitRecycle = (
  environment: AcceptanceEnvironment,
  outcome: OwnedRecycling["outcome"],
) => Promise<OwnedRecycling>;

/** 默认收尾：确认退出并删除，等价于一次成功的自有环境回收。 */
const confirmedRecycle: UnitRecycle = async (environment, outcome) =>
  stubRecycling(outcome, {
    exitConfirmation: {
      confirmed: true,
      state: "prepared",
      processLiveness: "exited",
      serviceReadiness: "not-evaluated",
      detail: "unit stub",
    },
    deletion: stubDeletion(environment.facts),
  });

const retained = new Set<string>();

afterEach(async () => {
  const pending = [...retained];
  retained.clear();
  for (const directory of pending)
    await rm(directory, { recursive: true, force: true });
});

/** 单元层的一次虚拟场景世代：环境不来自环境包，只用于核验调用方归属分支。 */
async function unitTargets(recycle: UnitRecycle = confirmedRecycle): Promise<{
  readonly lifecycle: JourneyEnvironmentLifecycle;
  readonly closed: OwnedRecycling["outcome"][];
  readonly evidenceDirectory: string;
  readonly workspaceRoot: string;
}> {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "digital-cli-journey-runner-unit-"),
  );
  retained.add(workspaceRoot);
  const evidenceDirectory = path.join(workspaceRoot, "evidence");
  const closed: OwnedRecycling["outcome"][] = [];
  let index = 0;
  return {
    evidenceDirectory,
    workspaceRoot,
    closed,
    lifecycle: {
      async open() {
        const directory = path.join(workspaceRoot, `scenario-${index++}`);
        await mkdir(directory, { recursive: true });
        return stubScenarioEnvironment({ workspacePath: directory });
      },
      async close({ environment, outcome }) {
        closed.push(outcome);
        return await recycle(environment, outcome);
      },
    },
  };
}

describe("CLI journey runner", () => {
  it("stops a credentialed live journey at its first unexpected command failure with that command's diagnostic", () => {
    expect(() =>
      assertHaltedJourneyCommand(
        { name: "live TMDB scan", args: [], haltOnFailure: true },
        {
          commandName: "live TMDB scan",
          exitCode: 1,
          stdout: "",
          stderr: "TMDB 官方来源请求失败：HTTP 401",
        },
      ),
    ).toThrow("live TMDB scan failed with exit 1");
    expect(() =>
      assertHaltedJourneyCommand(
        { name: "live TMDB scan", args: [], haltOnFailure: true },
        {
          commandName: "live TMDB scan",
          exitCode: 1,
          stdout: "",
          stderr: "TMDB 官方来源请求失败：HTTP 401",
        },
      ),
    ).toThrow("TMDB 官方来源请求失败：HTTP 401");
    expect(() =>
      assertHaltedJourneyCommand(
        { name: "expected business failure", args: [] },
        {
          commandName: "expected business failure",
          exitCode: 1,
          stdout: "",
          stderr: "expected",
        },
      ),
    ).not.toThrow();
  });

  it("redacts every configured private value from halted-command diagnostics", () => {
    const command = {
      name: "live private source",
      args: [],
      haltOnFailure: true as const,
      env: {
        DIGITAL_TMDB_ACCESS_TOKEN: "placeholder-tmdb-token",
        DIGITAL_OMDB_API_KEY: "placeholder-omdb-key",
        DIGITAL_SESSION_COOKIE: "placeholder-session-cookie",
      },
    };
    const leaked = [
      "token=placeholder-tmdb-token",
      "apikey=placeholder-omdb-key",
      "Cookie: placeholder-session-cookie",
    ].join("\n");

    expect(redactJourneyDiagnostic(leaked, [command])).toContain("[REDACTED]");
    expect(redactJourneyDiagnostic(leaked, [command])).not.toContain(
      "placeholder-tmdb-token",
    );
    expect(redactJourneyDiagnostic(leaked, [command])).not.toContain(
      "placeholder-omdb-key",
    );
    expect(redactJourneyDiagnostic(leaked, [command])).not.toContain(
      "placeholder-session-cookie",
    );
    expect(() =>
      assertHaltedJourneyCommand(command, {
        commandName: command.name,
        exitCode: 1,
        stdout: leaked,
        stderr: leaked,
      }),
    ).toThrow("[REDACTED]");
    expect(() =>
      assertHaltedJourneyCommand(command, {
        commandName: command.name,
        exitCode: 1,
        stdout: leaked,
        stderr: leaked,
      }),
    ).not.toThrow("placeholder-tmdb-token");
  });

  it("does not retain original private diagnostics through an assertion failure cause or stack", () => {
    const command = {
      name: "live private source",
      args: [],
      env: { DIGITAL_TMDB_ACCESS_TOKEN: "placeholder-tmdb-token" },
    };
    const original = new Error("assertion saw placeholder-tmdb-token");
    original.stack = `Error: assertion saw placeholder-tmdb-token\n  at private`;
    const error = formatJourneyAssertionFailure({
      mode: "source",
      journeyName: "private-live",
      commands: [command],
      results: [
        {
          commandName: command.name,
          exitCode: 1,
          stdout: "stdout placeholder-tmdb-token",
          stderr: "stderr placeholder-tmdb-token",
        },
      ],
      error: original,
    });
    const cause = (error as Error & { readonly cause?: unknown }).cause;
    const observable = JSON.stringify({
      message: error.message,
      stack: error.stack,
      cause:
        cause instanceof Error
          ? { message: cause.message, stack: cause.stack }
          : cause,
    });

    expect(observable).toContain("[REDACTED]");
    expect(observable).not.toContain("placeholder-tmdb-token");
  });

  it.each([
    ["主路径", "main", "assertions"],
    ["收尾", "teardown", "teardown"],
  ] as const)(
    "%s bare rejection 仍拒绝并清理工作目录",
    async (_, label, stage) => {
      let capturedWorkDir = "";
      const journey: CliJourney = {
        name: `bare-${label}-rejection`,
        modes: ["source"],
        async setup(context) {
          capturedWorkDir = context.workDir;
        },
        commands() {
          return [];
        },
        async assertions() {
          if (stage === "assertions") await Promise.reject();
        },
        async teardown() {
          if (stage === "teardown") await Promise.reject();
        },
      };
      const unit = await unitTargets();

      await expect(
        runJourney({
          journey,
          mode: "source",
          lifecycle: unit.lifecycle,
          evidenceDirectory: unit.evidenceDirectory,
        }),
      ).rejects.toThrow(`${label} failure: undefined`);
      await expect(access(capturedWorkDir)).rejects.toThrow();
    },
  );

  it("命令改写媒体后失败仍执行收尾并同时报告主失败与漂移", async () => {
    const baselines = new Map<string, string>();
    let capturedWorkDir = "";
    let mediaFile = "";
    let stateReleased = false;
    const journey: CliJourney = {
      name: "teardown-on-halt",
      modes: ["source"],
      async setup(context) {
        capturedWorkDir = context.workDir;
        const mediaRoot = path.join(context.workDir, "test-media");
        mediaFile = path.join(mediaRoot, "publication.bin");
        await mkdir(mediaRoot);
        await writeFile(mediaFile, "before");
        baselines.set(context.workDir, "before");
      },
      commands() {
        return [
          {
            name: "mutating command",
            args: [],
            haltOnFailure: true,
          },
        ];
      },
      async assertions() {
        throw new Error("非零 halt 后不应执行普通断言");
      },
      async teardown({ context }) {
        const baseline = baselines.get(context.workDir);
        if (baseline === undefined) return;
        try {
          const after = await readFile(mediaFile, "utf8");
          if (after !== baseline) throw new Error("测试媒体根发生漂移");
        } finally {
          baselines.delete(context.workDir);
          stateReleased = true;
        }
      },
    };
    const unit = await unitTargets();

    await expect(
      runJourney({
        journey,
        mode: "source",
        lifecycle: unit.lifecycle,
        evidenceDirectory: unit.evidenceDirectory,
        async executeCommand({ command }) {
          await writeFile(mediaFile, "after");
          return {
            commandName: command.name,
            exitCode: 7,
            stdout: "",
            stderr: "主命令失败",
          };
        },
      }),
    ).rejects.toThrow(
      /mutating command failed with exit 7[\s\S]*测试媒体根发生漂移/u,
    );
    expect(stateReleased).toBe(true);
    expect(baselines).toHaveProperty("size", 0);
    await expect(access(capturedWorkDir)).rejects.toThrow();
  });

  it("自有环境成功时保存结果后停止并按结局删除", async () => {
    const unit = await unitTargets();
    const journey: CliJourney = {
      name: "owned-success",
      modes: ["source"],
      async setup() {},
      commands: () => [{ name: "no-op", args: [] }],
      async assertions() {},
    };

    await expect(
      runJourney({
        journey,
        mode: "source",
        lifecycle: unit.lifecycle,
        evidenceDirectory: unit.evidenceDirectory,
        async executeCommand({ command }) {
          return {
            commandName: command.name,
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      }),
    ).resolves.toBe("source:owned-success:passed");
    expect(unit.closed).toEqual(["success"]);
    const evidence = JSON.parse(
      await readFile(
        path.join(unit.evidenceDirectory, "t11-stub.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      outcome: "success",
      deleteStatus: "deleted",
      sourceMode: "offline",
    });
  });

  it("自有环境失败时保留数据并把停止与删除问题与主失败并列报告", async () => {
    const unit = await unitTargets(async (environment, outcome) => ({
      ...stubRecycling(outcome, {
        exitConfirmation: {
          confirmed: false,
          state: "prepared",
          processLiveness: "unknown",
          serviceReadiness: "unknown",
          detail: "无法确认退出",
        },
        retainedDataRoot: environment.productDataRoot,
        retainedLogs: ["logs/stop.log"],
      }),
      problems: ["收尾停止未确认：stop=not-confirmed 无法确认退出"],
    }));
    const journey: CliJourney = {
      name: "owned-failure",
      modes: ["source"],
      async setup() {},
      commands: () => [{ name: "failing", args: [], haltOnFailure: true }],
      async assertions() {},
    };

    await expect(
      runJourney({
        journey,
        mode: "source",
        lifecycle: unit.lifecycle,
        evidenceDirectory: unit.evidenceDirectory,
        async executeCommand({ command }) {
          return {
            commandName: command.name,
            exitCode: 4,
            stdout: "",
            stderr: "业务失败",
          };
        },
      }),
    ).rejects.toThrow(
      /main failure:[\s\S]*收尾停止未确认[\s\S]*stop=not-confirmed/u,
    );
    expect(unit.closed).toEqual(["failure"]);
    const evidence = JSON.parse(
      await readFile(
        path.join(unit.evidenceDirectory, "t11-stub.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      outcome: "failure",
      deleteStatus: null,
      retainedDataRoot: expect.any(String),
    });
  });

  it("信号中断按 interrupted 收尾，不删除自有数据也不伪造退出确认", async () => {
    const unit = await unitTargets();
    const cancellation = new AbortController();
    const journey: CliJourney = {
      name: "owned-interrupt",
      modes: ["source"],
      async setup() {},
      commands: () => [{ name: "interrupted command", args: [] }],
      async assertions() {},
    };

    await expect(
      runJourney({
        journey,
        mode: "source",
        lifecycle: unit.lifecycle,
        evidenceDirectory: unit.evidenceDirectory,
        signal: cancellation.signal,
        async executeCommand({ command, signal }) {
          signal?.addEventListener("abort", () => {}, { once: true });
          cancellation.abort(new Error("received SIGINT"));
          return {
            commandName: command.name,
            exitCode: 130,
            stdout: "",
            stderr: "",
          };
        },
      }),
    ).rejects.toThrow(/interruption failure/u);
    expect(unit.closed).toEqual(["interrupted"]);
  });

  it("环境收尾自身抛出异常时仍报告主失败并保留自有工作区", async () => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "digital-cli-journey-runner-throwing-"),
    );
    retained.add(workspaceRoot);
    const journey: CliJourney = {
      name: "recycling-throw",
      modes: ["source"],
      async setup() {},
      commands: () => [{ name: "failing", args: [], haltOnFailure: true }],
      async assertions() {},
    };

    await expect(
      runJourney({
        journey,
        mode: "source",
        evidenceDirectory: path.join(workspaceRoot, "evidence"),
        lifecycle: {
          async open() {
            return stubScenarioEnvironment({ workspacePath: workspaceRoot });
          },
          async close() {
            throw new Error("收尾公开调用失败：secret-token");
          },
        },
        async executeCommand({ command }) {
          return {
            commandName: command.name,
            exitCode: 9,
            stdout: "secret-token",
            stderr: "",
          };
        },
      }),
    ).rejects.toThrow(/main failure[\s\S]*环境收尾抛出异常/u);
  });
});
