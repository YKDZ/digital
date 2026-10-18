import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicApiClient } from "@digital/public-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inspectEnvironment,
  prepareEnvironment,
  startEnvironment,
  stopEnvironment,
  type JsonValue,
  type PrepareOperationResult,
} from "../src/index.ts";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
);
const environmentCli = path.join("packages", "environment", "dist", "cli.js");
const environmentCliSource = path.join(
  "packages",
  "environment",
  "src",
  "cli.ts",
);
const parentCredential = "parent-only-credential-8f31c2";
/** 真实管线要跑 Turbo、迁移与产品命令，单个用例给足余量。 */
const realRunTimeout = 420_000;

type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

const createdContainers: string[] = [];
const temporaryDirectories: string[] = [];

async function run(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<CommandResult> {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd ?? workspaceRoot,
    env: input.env ?? {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** 每次准备都换一个唯一环境名，避免用例之间共享持久记录。 */
async function prepareFresh(options?: {
  readonly config?: { readonly [key: string]: JsonValue };
  readonly inputs?: readonly string[];
}): Promise<{
  readonly name: string;
  readonly result: PrepareOperationResult;
}> {
  const name = `t01-${randomUUID().slice(0, 8)}`;
  const result = await prepareOwned(name, options);
  return { name, result };
}

/**
 * 先登记自有容器再发起准备，成功与失败都由 afterAll 只回收本轮自己的容器。
 * 锁文件留在工作区管理锁区，不随环境删除。
 */
async function prepareOwned(
  name: string,
  options?: {
    readonly config?: { readonly [key: string]: JsonValue };
    readonly inputs?: readonly string[];
  },
): Promise<PrepareOperationResult> {
  createdContainers.push(
    path.join(workspaceRoot, ".digital", "environments", name),
  );
  return await prepareEnvironment({
    workspacePath: workspaceRoot,
    environment: name,
    ...(options?.config === undefined ? {} : { config: options.config }),
    ...(options?.inputs === undefined ? {} : { inputs: options.inputs }),
  });
}

/** 经正式服务 API 写入一条可跨世代读取的业务记录。 */
async function recordLibraryScan(
  environment: string,
  label: string,
): Promise<string> {
  const started = await startEnvironment({
    workspacePath: workspaceRoot,
    environment,
  });
  expect(["ready", "already-ready"]).toContain(started.status);
  if (
    (started.status !== "ready" && started.status !== "already-ready") ||
    started.run.address === null
  )
    throw new Error(started.failure?.message ?? "环境服务未就绪");
  const material = await temporaryDirectory("digital-01-material-");
  try {
    const client = createPublicApiClient({ baseUrl: started.run.address });
    const options = await client.listAssetLibraryOptions();
    const library = await client.saveAssetLibrary({
      displayName: label,
      directories: [material],
      recognitionProfileIds: options.recognitionProfiles.map(({ id }) => id),
      sourceIdentities: [],
    });
    const scan = await client.startAssetLibraryScan(library.id);
    let inspection = await client.inspectAssetLibraryScan(
      scan.parentExecutionId,
    );
    for (
      let attempt = 0;
      attempt < 100 && inspection.status === "running";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await client.inspectAssetLibraryScan(scan.parentExecutionId);
    }
    expect(inspection.status).toBe("completed");
    return scan.parentExecutionId;
  } finally {
    if (started.status === "ready") {
      const stopped = await stopEnvironment({
        workspacePath: workspaceRoot,
        environment,
      });
      expect(stopped.status).toBe("stopped");
    }
  }
}

async function workflowHistoryIds(environment: string): Promise<string[]> {
  const started = await startEnvironment({
    workspacePath: workspaceRoot,
    environment,
  });
  expect(["ready", "already-ready"]).toContain(started.status);
  if (
    (started.status !== "ready" && started.status !== "already-ready") ||
    started.run.address === null
  )
    throw new Error(started.failure?.message ?? "环境服务未就绪");
  try {
    const history = await createPublicApiClient({
      baseUrl: started.run.address,
    }).listWorkflowHistory({ limit: 100 });
    return history.items.map(({ execution }) => execution.id);
  } finally {
    if (started.status === "ready") {
      const stopped = await stopEnvironment({
        workspacePath: workspaceRoot,
        environment,
      });
      expect(stopped.status).toBe("stopped");
    }
  }
}

async function readLogs(result: PrepareOperationResult): Promise<string> {
  return (
    await Promise.all(
      result.logs.files.map((file) => readFile(file, "utf8").catch(() => "")),
    )
  ).join("\n");
}

beforeAll(() => {
  for (const name of [
    "DIGITAL_PRODUCT_DATA",
    "DIGITAL_TMDB_ACCESS_TOKEN",
    "PORT",
    "NODE_OPTIONS",
  ])
    delete process.env[name];
});

afterAll(async () => {
  // 只回收本轮自有容器与临时目录：工作区管理根、锁区和其他环境不属于本次测试。
  for (const container of createdContainers)
    await rm(container, { recursive: true, force: true });
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
});

describe("从空根准备一个可供产品使用的环境", () => {
  it(
    "正式构建、迁移与产品读取全部成功才记已准备，查看不称就绪",
    async () => {
      const before = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: "t01-not-created-yet",
      });
      expect(before.state).toBe("unprepared");
      expect(before.serviceReadiness).toBe("not-evaluated");

      const { name, result } = await prepareFresh();
      expect(result.status).toBe("prepared");
      expect(result.cleanup.state).toBe("stopped");
      expect(result.environment.environmentId).not.toBeNull();
      expect(result.environment.environment).toBe(name);
      expect(result.environment.productDataRoot).toContain(
        path.join(".digital", "environments", name),
      );

      const after = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(after.status).toBe("ok");
      expect(after.state).toBe("prepared");
      expect(after.serviceReadiness).toBe("not-evaluated");
      expect(after.operations?.map((operation) => operation.outcome)).toEqual([
        "prepared",
      ]);
    },
    realRunTimeout,
  );

  it(
    "同一环境的并发变更命令由互斥串行，两条命令都交出结果",
    async () => {
      const name = `t01-${randomUUID().slice(0, 8)}`;
      const [first, second] = await Promise.all([
        prepareOwned(name),
        prepareOwned(name),
      ]);
      expect(first.status).toBe("prepared");
      expect(second.status).toBe("prepared");
      expect(first.environment.environmentId).toBe(
        second.environment.environmentId,
      );
      expect(new Set([first.logs.directory, second.logs.directory]).size).toBe(
        2,
      );

      const inspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(inspection.state).toBe("prepared");
      expect(inspection.operations).toHaveLength(2);
      expect(
        inspection.operations?.every(
          (operation) => operation.outcome === "prepared",
        ),
      ).toBe(true);
    },
    realRunTimeout,
  );
});

describe("所选环境决定数据根与配置", () => {
  it(
    "父终端遗留的数据根、端口与来源凭据不能改变所选环境",
    async () => {
      const untouchedRoot = await temporaryDirectory("digital-01-parent-root-");
      const parentDataRoot = path.join(untouchedRoot, "product-data");
      process.env.DIGITAL_PRODUCT_DATA = parentDataRoot;
      process.env.PORT = "19999";
      process.env.DIGITAL_TMDB_ACCESS_TOKEN = parentCredential;
      try {
        const { name, result } = await prepareFresh();
        expect(result.status).toBe("prepared");
        // 真实外部条件：产品迁移会在目标根建目录，这里连目录都不存在。
        expect(existsSync(parentDataRoot)).toBe(false);

        const executionId = await recordLibraryScan(name, "父配置隔离");
        expect(await workflowHistoryIds(name)).toContain(executionId);

        const diagnostics = `${JSON.stringify(result)}${await readLogs(result)}`;
        expect(diagnostics).not.toContain(parentCredential);
      } finally {
        delete process.env.DIGITAL_PRODUCT_DATA;
        delete process.env.PORT;
        delete process.env.DIGITAL_TMDB_ACCESS_TOKEN;
      }
    },
    realRunTimeout,
  );

  it(
    "输入目录不能落在环境自有目录内",
    async () => {
      const { name, result } = await prepareFresh();
      expect(result.status).toBe("prepared");
      const inside = path.join(result.environment.productDataRoot, "material");
      await mkdir(inside);
      const rejected = await prepareEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
        inputs: [inside],
      });
      expect(rejected.status).toBe("invalid-request");
      expect(rejected.failure?.message).toContain("重叠");
      expect(rejected.cleanup.state).toBe("not-started");

      const inspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(inspection.state).toBe("prepared");
    },
    realRunTimeout,
  );

  it(
    "产品数据根被预先重定向到环境之外时拒绝准备并保留两侧数据",
    async () => {
      const external = await temporaryDirectory("digital-01-external-root-");
      await writeFile(path.join(external, "keep.txt"), "外部自有数据");
      const { name, result } = await prepareFresh();
      expect(result.status).toBe("prepared");
      const productDataRoot = result.environment.productDataRoot;
      await recordLibraryScan(name, "越界重定向");

      await rm(productDataRoot, { recursive: true, force: true });
      await symlink(external, productDataRoot);

      const rejected = await prepareEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(rejected.status).toBe("unmanaged");
      expect(rejected.failure?.stage).toBe("claim");
      // 拒绝发生在任何正式命令之前，因此收尾结论仍是尚未开始。
      expect(rejected.cleanup.state).toBe("not-started");

      // 外部目标未被任何正式命令写入，环境记录也不被这次拒绝改写。
      expect(await readdir(external)).toEqual(["keep.txt"]);
      expect(await readFile(path.join(external, "keep.txt"), "utf8")).toBe(
        "外部自有数据",
      );
      const inspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(inspection.state).toBe("unmanaged");
      expect(inspection.reason).toContain("重定向");
    },
    realRunTimeout,
  );
});

describe("重复准备保留状态，配置变化不隐式清空", () => {
  it(
    "同配置重复准备后业务写入值仍可读取，异配置明确不兼容且保留原状态",
    async () => {
      const config = { profile: "base" };
      const { name, result } = await prepareFresh({ config });
      expect(result.status).toBe("prepared");
      const executionId = await recordLibraryScan(name, "重复准备");
      const historyBeforeRepeat = await workflowHistoryIds(name);
      expect(historyBeforeRepeat).toContain(executionId);

      const repeated = await prepareEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
        config,
      });
      expect(repeated.status).toBe("prepared");
      expect(repeated.environment.environmentId).toBe(
        result.environment.environmentId,
      );
      expect(repeated.environment.dataGeneration).toBe(
        result.environment.dataGeneration,
      );
      expect(await workflowHistoryIds(name)).toEqual(historyBeforeRepeat);

      const changedConfig = await prepareEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
        config: { profile: "other" },
      });
      expect(changedConfig.status).toBe("config-incompatible");
      expect(changedConfig.incompatibility).toContain("运行配置");
      expect(changedConfig.logs.directory).toBeNull();

      const changedInputs = await prepareEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
        config,
        inputs: [await temporaryDirectory("digital-01-input-")],
      });
      expect(changedInputs.status).toBe("config-incompatible");
      expect(changedInputs.incompatibility).toContain("输入目录列表");

      const inspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(inspection.state).toBe("prepared");
      expect(inspection.environment.config).toEqual({ profile: "base" });
      expect(await workflowHistoryIds(name)).toEqual(historyBeforeRepeat);
    },
    realRunTimeout,
  );
});

describe("普通失败保留诊断并收尾自有进程", () => {
  it(
    "正式迁移失败时不记已准备，返回阶段、完整日志并如实收尾",
    async () => {
      const { name, result } = await prepareFresh();
      expect(result.status).toBe("prepared");
      // 真实外部条件：所选产品根里的数据库文件不是产品可用的 SQLite 数据库。
      await writeFile(
        path.join(result.environment.productDataRoot, "catalogue.sqlite"),
        "这不是一个 SQLite 数据库",
      );

      const failed = await prepareEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(failed.status).toBe("failed");
      expect(failed.failure?.stage).toBe("migrate");
      expect(failed.cleanup.state).toBe("stopped");
      expect(
        failed.logs.files.some((file) => file.endsWith("migrate.log")),
      ).toBe(true);

      const inspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(inspection.state).toBe("failed");
      expect(inspection.preparation?.lastFailure?.stage).toBe("migrate");
    },
    realRunTimeout,
  );

  it(
    "日志目录无法写出时仍交出失败结果、可用日志指针与实际收尾，不静默隐藏",
    async () => {
      const { name, result } = await prepareFresh();
      expect(result.status).toBe("prepared");
      const logsRoot = path.join(
        workspaceRoot,
        ".digital",
        "environments",
        name,
        "logs",
      );
      await rm(logsRoot, { recursive: true, force: true });
      await writeFile(logsRoot, "日志区被普通文件占据");

      const failed = await prepareEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(failed.status).toBe("failed");
      expect(failed.failure?.stage).toBe("operation");
      expect(failed.failure?.message).toContain("准备操作异常");
      // 收尾结论来自实际持有的子进程：本次没有启动任何命令。
      expect(failed.cleanup.state).toBe("stopped");
      expect(failed.logs.directory).not.toBeNull();
      expect(failed.diagnostics.some((item) => item.includes("日志"))).toBe(
        true,
      );

      const inspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(inspection.state).toBe("failed");
      expect(inspection.preparation?.lastFailure?.stage).toBe("operation");
    },
    realRunTimeout,
  );

  it(
    "阶段日志写入被文件系统拒绝时以写入拒绝为首因，收尾自有进程并交出可用现场",
    async () => {
      const { name, result } = await prepareFresh();
      expect(result.status).toBe("prepared");
      const shimDirectory = await temporaryDirectory("digital-01-shim-");
      // 真实外部条件：下一阶段日志指向永远拒绝写入的 /dev/full。
      await writeFile(
        path.join(shimDirectory, "pnpm"),
        [
          "#!/bin/sh",
          `base='${path.join(workspaceRoot, ".digital", "environments", name)}'`,
          'op=$(ls "$base/logs" | tail -1)',
          'ln -s /dev/full "$base/logs/$op/migrate.log"',
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const previousPath = process.env.PATH ?? "";
      process.env.PATH = `${shimDirectory}:${previousPath}`;
      let failed: PrepareOperationResult;
      try {
        failed = await prepareOwned(name);
      } finally {
        process.env.PATH = previousPath;
      }
      expect(failed.status).toBe("failed");
      expect(failed.failure?.stage).toBe("migrate");
      expect(failed.failure?.message).toContain("阶段日志写入被拒绝");
      expect(failed.failure?.message).toContain("ENOSPC");
      // 写入拒绝留在受控操作内交出结果，不是操作进程消失后的 unknown。
      expect(failed.failure?.message).not.toContain("未交出结果");
      expect(failed.cleanup.state).toBe("stopped");
      expect(failed.environment.environmentId).toBe(
        result.environment.environmentId,
      );
      expect(failed.logs.directory).not.toBeNull();
      expect(failed.logs.files.some((file) => file.endsWith("build.log"))).toBe(
        true,
      );
      expect(
        failed.diagnostics.some((item) => item.includes("日志未完整保存")),
      ).toBe(true);

      const inspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(inspection.state).toBe("failed");
      expect(inspection.preparation?.lastFailure?.stage).toBe("migrate");
    },
    realRunTimeout,
  );

  it(
    "构建命令失败时不假成功，且凭据样式输出在落盘前已完整脱敏",
    async () => {
      const workspace = await temporaryDirectory("digital-01-workspace-");
      const shimDirectory = await temporaryDirectory("digital-01-shim-");
      // 全部为合成凭据样式；分两次 printf 写入让 Bearer 值跨输出 chunk。
      const secrets = [
        "chunked-token-4f2a",
        "basic-placeholder-9d31",
        "session-value-6b18",
        "refresh-value-2c74",
      ];
      await writeFile(
        path.join(shimDirectory, "pnpm"),
        [
          "#!/bin/sh",
          "printf '%s' 'Authorization: Bearer chunked-'",
          "printf '%s\\n' 'token-4f2a'",
          "echo 'Authorization: Basic basic-placeholder-9d31'",
          "echo 'Cookie: session=session-value-6b18; refresh=refresh-value-2c74'",
          "echo '构建失败：依赖解析错误' >&2",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const previousPath = process.env.PATH ?? "";
      process.env.PATH = `${shimDirectory}:${previousPath}`;
      try {
        const result = await prepareEnvironment({
          workspacePath: workspace,
          environment: "t01-build-failure",
        });
        expect(result.status).toBe("failed");
        expect(result.failure?.stage).toBe("build");
        expect(result.cleanup.state).toBe("stopped");
        const diagnostics = `${JSON.stringify(result)}${await readLogs(result)}`;
        for (const secret of secrets) expect(diagnostics).not.toContain(secret);
        expect(diagnostics).toContain("Authorization: [REDACTED]");
        expect(diagnostics).toContain("Cookie: [REDACTED]");
        // 普通诊断、阶段、退出信息与完整日志必须仍可用。
        expect(diagnostics).toContain("构建失败：依赖解析错误");
        expect(
          result.logs.files.some((file) => file.endsWith("build.log")),
        ).toBe(true);
      } finally {
        process.env.PATH = previousPath;
      }
    },
    realRunTimeout,
  );
});

describe("薄 CLI 只补参数、结果与退出码", () => {
  const cli = (args: readonly string[], mode: "dist" | "source" = "dist") =>
    run({
      command: process.execPath,
      args:
        mode === "dist"
          ? [path.join(workspaceRoot, environmentCli), ...args]
          : [
              "--conditions=digital-source",
              path.join(workspaceRoot, environmentCliSource),
              ...args,
            ],
    });

  it(
    "帮助、缺少必需参数与无效请求分别交出可区分的退出码",
    async () => {
      const help = await cli(["--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("prepare");

      const missing = await cli(["prepare"]);
      expect(missing.code).toBe(2);

      const badConfig = await cli([
        "prepare",
        "--environment",
        "t01-cli-never-created",
        "--config-json",
        "{坏",
      ]);
      expect(badConfig.code).toBe(5);
      expect(badConfig.stderr).toContain("运行配置不是合法 JSON");

      const controlledWithoutManifest = await cli(
        [
          "enter",
          "--environment",
          "t01-cli-never-created",
          "--source-mode",
          "controlled",
        ],
        "source",
      );
      expect(controlledWithoutManifest.code).toBe(5);
      expect(controlledWithoutManifest.stderr).toContain(
        "受控来源模式必须在运行配置中给出 sourceIo 清单选择",
      );
    },
    realRunTimeout,
  );

  it(
    "查看未准备环境为成功结果，准备后 CLI 与程序出口一致",
    async () => {
      const name = `t01-${randomUUID().slice(0, 8)}`;
      createdContainers.push(
        path.join(workspaceRoot, ".digital", "environments", name),
      );
      const unprepared = await cli(
        ["inspect", "--environment", name],
        "source",
      );
      expect(unprepared.code, unprepared.stderr).toBe(0);
      expect(
        (JSON.parse(unprepared.stdout) as { data: { state: string } }).data
          .state,
      ).toBe("unprepared");

      const prepared = await cli([
        "prepare",
        "--environment",
        name,
        "--config-json",
        '{"profile":"cli"}',
      ]);
      expect(prepared.code, prepared.stderr).toBe(0);
      const preparedData = (
        JSON.parse(prepared.stdout) as {
          variant: string;
          data: { logs: { directory: string } };
        }
      ).data;
      expect((JSON.parse(prepared.stdout) as { variant: string }).variant).toBe(
        "prepared",
      );

      const incompatible = await cli([
        "prepare",
        "--environment",
        name,
        "--config-json",
        '{"profile":"other"}',
      ]);
      expect(incompatible.code).toBe(3);

      const text = await cli([
        "inspect",
        "--environment",
        name,
        "--output-format",
        "text",
      ]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain("已准备");
      expect(text.stdout).toContain("服务就绪：未评估");
      expect(text.stdout).toContain(preparedData.logs.directory);

      const viaApi = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(viaApi.state).toBe("prepared");
      expect(viaApi.environment.config).toEqual({ profile: "cli" });
    },
    realRunTimeout,
  );

  it(
    "首次进入缺少来源模式时在任何准备前给出可修正错误",
    async () => {
      const name = `t01-enter-source-${randomUUID().slice(0, 8)}`;
      createdContainers.push(
        path.join(workspaceRoot, ".digital", "environments", name),
      );

      const result = await cli(["enter", "--environment", name], "source");

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(5);
      expect(result.stderr).toContain("首次进入必须显式指定 --source-mode");
      const inspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: name,
      });
      expect(inspection.state).toBe("unprepared");
    },
    realRunTimeout,
  );
});
