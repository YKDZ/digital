import { describe, expect, it } from "vitest";

import {
  assertHaltedJourneyCommand,
  formatJourneyAssertionFailure,
  redactJourneyDiagnostic,
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
});
