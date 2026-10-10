import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  requireSourceSelectionEnvironment,
  sourceModeVariable,
  sourceConfigVariable,
  sourceIdentityVariable,
  validateSourceSelection,
} from "../src/internal/source-selection.ts";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
);
const environmentCli = path.join(
  workspaceRoot,
  "packages",
  "environment",
  "dist",
  "cli.js",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const manifest = path.join(
  workspaceRoot,
  "fixtures",
  "controlled-source-io",
  "manifest.json",
);
const contentIdentity = `sha256:${"0".repeat(64)}`;

describe("环境只传递有界的来源装配选择", () => {
  it("受控选择核验通过时只派生三个装配变量", () => {
    const selection = validateSourceSelection({
      sourceMode: "controlled",
      config: {
        profile: "t06",
        webPort: 35001,
        sourceIo: { manifestPath: manifest, contentIdentity },
      },
      workspacePath: workspaceRoot,
    });
    expect(selection).toEqual({
      mode: "controlled",
      manifestPath: manifest,
      contentIdentity,
    });
    expect(
      requireSourceSelectionEnvironment({
        sourceMode: "controlled",
        config: { sourceIo: { manifestPath: manifest, contentIdentity } },
        workspacePath: workspaceRoot,
      }),
    ).toEqual({
      [sourceModeVariable]: "controlled",
      [sourceConfigVariable]: manifest,
      [sourceIdentityVariable]: contentIdentity,
    });
  });

  it("未声明、真实与离线选择都保持各自的封闭边界", () => {
    expect(
      validateSourceSelection({
        sourceMode: "offline",
        config: {},
        workspacePath: workspaceRoot,
      }),
    ).toEqual({ mode: "offline" });
    // 托管世代的离线选择也必须显式传给可执行根，空变量集合会被读成未选择而落回真实装配。
    expect(
      requireSourceSelectionEnvironment({
        sourceMode: "offline",
        config: {},
        workspacePath: workspaceRoot,
      }),
    ).toEqual({ [sourceModeVariable]: "offline" });
    expect(
      requireSourceSelectionEnvironment({
        sourceMode: "real",
        config: {},
        workspacePath: workspaceRoot,
      }),
    ).toEqual({ [sourceModeVariable]: "real" });
  });

  it("任何不完整、越界或与模式不符的受控选择都在请求阶段被拒", () => {
    const rejected: {
      sourceMode: string;
      config: Record<string, unknown>;
    }[] = [
      { sourceMode: "controlled", config: {} },
      {
        sourceMode: "controlled",
        config: { sourceIo: { manifestPath: manifest } },
      },
      {
        sourceMode: "controlled",
        config: {
          sourceIo: { manifestPath: "fixtures/manifest.json", contentIdentity },
        },
      },
      {
        sourceMode: "controlled",
        config: {
          sourceIo: {
            manifestPath: manifest,
            contentIdentity: "sha256:短",
            extra: 1,
          },
        },
      },
      {
        sourceMode: "controlled",
        config: {
          sourceIo: path.join(
            workspaceRoot,
            "packages",
            "environment",
            "manifest.json",
          ),
        },
      },
      {
        sourceMode: "offline",
        config: { sourceIo: { manifestPath: manifest, contentIdentity } },
      },
      { sourceMode: "unknown", config: {} },
    ];
    for (const input of rejected) {
      const outcome = validateSourceSelection({
        ...input,
        config: input.config as Record<string, never>,
        workspacePath: workspaceRoot,
      });
      expect(outcome).toHaveProperty("reason");
    }
    expect(() =>
      requireSourceSelectionEnvironment({
        sourceMode: "controlled",
        config: {},
        workspacePath: workspaceRoot,
      }),
    ).toThrow("已核验的来源选择在操作中失效");
  });
});

describe("环境 CLI 在构建与产品读取之前拒绝无效受控选择", () => {
  it.each([
    ["缺少清单选择", {}],
    [
      "身份格式无效",
      { sourceIo: { manifestPath: manifest, contentIdentity: "sha256:无" } },
    ],
    [
      "清单路径不是绝对路径",
      { sourceIo: { manifestPath: "fixtures/manifest.json", contentIdentity } },
    ],
    [
      "清单选择包含未知字段",
      { sourceIo: { manifestPath: manifest, contentIdentity, extra: 1 } },
    ],
  ])("%s 以无效请求退出，不进入构建与产品读取", async (_label, config) => {
    const container = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-environment-"),
    );
    temporaryDirectories.push(container);
    const workspace = path.join(container, "workspace");
    await mkdir(workspace, { recursive: true });
    const { code, stdout } = await execFileAsync(
      process.execPath,
      [
        environmentCli,
        "prepare",
        "--workspace-path",
        workspace,
        "--environment",
        "t06-selection",
        "--source-mode",
        "controlled",
        "--config-json",
        JSON.stringify(config),
      ],
      { cwd: workspaceRoot },
    )
      .then((result) => ({ code: 0, stdout: result.stdout }))
      .catch((error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? null,
        stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      }));
    expect(code).toBe(5);
    expect(stdout).toContain('"variant":"invalidRequest"');
    expect(stdout).toContain("受控");
    expect(stdout).not.toContain("响应正文");
    expect(stdout).not.toContain("turbo");
  });
});
