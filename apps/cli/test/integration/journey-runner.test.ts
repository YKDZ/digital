import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CliJourney } from "../e2e/journey.ts";
import {
  assertHaltedJourneyCommand,
  formatJourneyAssertionFailure,
  redactJourneyDiagnostic,
  runJourney,
} from "../e2e/run-journeys.ts";

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

      await expect(runJourney({ journey, mode: "source" })).rejects.toThrow(
        `${label} failure: undefined`,
      );
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

    await expect(
      runJourney({
        journey,
        mode: "source",
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
});
