import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const repository = path.resolve(import.meta.dirname, "../..");

await test("公共门禁按职责执行并在错误配置产生副作用前拒绝", async (context) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "digital-task-gate-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, "scripts"));
  await copyFile(
    path.join(repository, "scripts/task-gates.ts"),
    path.join(workspace, "scripts/task-gates.ts"),
  );
  await copyFile(
    path.join(repository, "scripts/controlled-development.ts"),
    path.join(workspace, "scripts/controlled-development.ts"),
  );
  await copyFile(
    path.join(repository, "scripts/turbo-process.ts"),
    path.join(workspace, "scripts/turbo-process.ts"),
  );
  await mkdir(path.join(workspace, "node_modules/.bin"), { recursive: true });
  await symlink(
    path.join(repository, "node_modules/.bin/turbo"),
    path.join(workspace, "node_modules/.bin/turbo"),
  );
  await mkdir(path.join(workspace, "packages/fixture"), { recursive: true });
  await writeFile(
    path.join(workspace, "packages/fixture/package.json"),
    JSON.stringify({ name: "fixture", private: true }),
  );
  await mkdir(path.join(workspace, "packages/automation"), {
    recursive: true,
  });
  await writeFile(
    path.join(workspace, "packages/automation/package.json"),
    JSON.stringify({
      name: "@digital/workspace-automation",
      private: true,
      scripts: {
        "development:controlled":
          "node -e \"require('node:fs').appendFileSync('../../controlled-invocations.txt', JSON.stringify({args: process.argv.slice(1), workspace: process.env.DIGITAL_AUTOMATION_WORKSPACE}) + '\\\\n')\"",
      },
    }),
  );
  await writeFile(
    path.join(workspace, "packages/automation/turbo.json"),
    JSON.stringify({
      extends: ["//"],
      tasks: {
        "development:controlled": {
          tags: ["work:preparation"],
          dependsOn: ["@fixture/tui#build"],
          cache: false,
          passThroughEnv: ["DIGITAL_AUTOMATION_WORKSPACE"],
        },
      },
    }),
  );
  await mkdir(path.join(workspace, "packages/tui"), { recursive: true });
  await writeFile(
    path.join(workspace, "packages/tui/package.json"),
    JSON.stringify({
      name: "@fixture/tui",
      private: true,
      scripts: {
        build:
          "node -e \"require('node:fs').appendFileSync('../../tui-builds.txt', 'built\\\\n')\"",
      },
    }),
  );
  await writeFile(
    path.join(workspace, "packages/tui/turbo.json"),
    JSON.stringify({
      extends: ["//"],
      tasks: { build: { tags: ["quality:light"], cache: false } },
    }),
  );
  const packageManager = (
    JSON.parse(
      await readFile(path.join(repository, "package.json"), "utf8"),
    ) as { packageManager: string }
  ).packageManager;
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({
      name: "gate-contract",
      private: true,
      type: "module",
      packageManager,
      scripts: {
        check: "node --conditions=digital-source scripts/task-gates.ts check",
        "check:heavy":
          "node --conditions=digital-source scripts/task-gates.ts check:heavy",
        "check:full":
          "node --conditions=digital-source scripts/task-gates.ts check:full",
        fix: "node --conditions=digital-source scripts/task-gates.ts fix",
        "test:light": "node scripts/record.ts light",
        "test:heavy": "node scripts/record.ts heavy",
        "test:conditional": "node scripts/record.ts conditional",
        "development:controlled":
          'DIGITAL_AUTOMATION_WORKSPACE="$PWD" node --conditions=digital-source scripts/controlled-development.ts',
      },
    }),
  );
  await writeFile(
    path.join(workspace, "scripts/record.ts"),
    'import { appendFileSync } from "node:fs"; appendFileSync("ran.txt", process.argv[2] + "\\n"); if (process.argv[3] === "fail") process.exitCode = 7;\n',
  );
  await writeFile(
    path.join(workspace, "pnpm-workspace.yaml"),
    "packages: ['packages/*']\nverifyDepsBeforeRun: false\n",
  );
  await writeFile(
    path.join(workspace, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  );
  await writeFile(
    path.join(workspace, "turbo.json"),
    JSON.stringify({
      tasks: {
        "//#check": { tags: ["quality:entry"] },
        "//#check:heavy": { tags: ["quality:entry"] },
        "//#check:full": { tags: ["quality:entry"] },
        "//#fix": { tags: ["work:repair"] },
        "//#test:light": { tags: ["quality:light"], cache: false },
        "//#test:heavy": { tags: ["quality:heavy"], cache: false },
        "//#test:conditional": { tags: ["quality:conditional"], cache: false },
        "development:controlled": {
          tags: ["work:preparation"],
          cache: false,
        },
      },
    }),
  );
  const result = spawnSync("pnpm", ["run", "check"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    await readFile(path.join(workspace, "ran.txt"), "utf8"),
    "light\n",
  );
  await writeFile(path.join(workspace, "tui-builds.txt"), "");
  const controlledRun = spawnSync(
    "pnpm",
    ["run", "development:controlled", "--", "--environment", "example"],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(controlledRun.error, undefined);
  assert.equal(
    controlledRun.status,
    0,
    controlledRun.stdout + controlledRun.stderr,
  );
  assert.equal(
    await readFile(path.join(workspace, "tui-builds.txt"), "utf8"),
    "built\n",
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(workspace, "controlled-invocations.txt"),
        "utf8",
      ),
    ),
    { args: ["--environment", "example"], workspace },
  );
  const controlledGraph = spawnSync(
    "pnpm",
    ["exec", "turbo", "run", "development:controlled", "--dry=json"],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(
    controlledGraph.status,
    0,
    controlledGraph.stdout + controlledGraph.stderr,
  );
  const graph = JSON.parse(controlledGraph.stdout) as {
    tasks: { taskId: string }[];
  };
  const graphTaskIds = graph.tasks.map((task) => task.taskId);
  assert.ok(
    graphTaskIds.includes(
      "@digital/workspace-automation#development:controlled",
    ),
  );
  assert.ok(graphTaskIds.includes("@fixture/tui#build"));
  assert.ok(!graphTaskIds.includes("//#development:controlled"));
  assert.match(result.stderr, /条件验收未执行.*test:conditional/u);
  const invalid = spawnSync("pnpm", ["run", "check", "--unsupported"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
  assert.equal(
    await readFile(path.join(workspace, "ran.txt"), "utf8"),
    "light\n",
  );

  type Task = {
    tags?: string[];
    cache?: boolean;
    dependsOn?: string[];
    command?: string[];
  };
  const baseManifest = JSON.parse(
    await readFile(path.join(workspace, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  const baseAutomationManifest = JSON.parse(
    await readFile(
      path.join(workspace, "packages/automation/package.json"),
      "utf8",
    ),
  ) as { scripts: Record<string, string> };
  const baseConfiguration = JSON.parse(
    await readFile(path.join(workspace, "turbo.json"), "utf8"),
  ) as { tasks: Record<string, Task> };
  const baseAutomationConfiguration = JSON.parse(
    await readFile(
      path.join(workspace, "packages/automation/turbo.json"),
      "utf8",
    ),
  ) as { extends: string[]; tasks: Record<string, Task> };
  const baseTuiConfiguration = JSON.parse(
    await readFile(path.join(workspace, "packages/tui/turbo.json"), "utf8"),
  ) as { extends: string[]; tasks: Record<string, Task> };

  const scenarios: {
    name: string;
    gate: string;
    configure: (
      manifest: typeof baseManifest,
      configuration: typeof baseConfiguration,
      automationManifest: typeof baseAutomationManifest,
      automationConfiguration: typeof baseAutomationConfiguration,
      tuiConfiguration: typeof baseTuiConfiguration,
    ) => void;
    expected: string;
    success: boolean;
  }[] = [
    {
      name: "完整门禁先轻后重，条件项保持未执行",
      gate: "check:full",
      configure: () => {},
      expected: "light\nheavy\n",
      success: true,
    },
    {
      name: "重门禁执行必要准备而不选择无关轻任务",
      gate: "check:heavy",
      configure: (manifest, configuration) => {
        manifest.scripts["prepare"] = "node scripts/record.ts prepared";
        configuration.tasks["//#prepare"] = {
          tags: ["work:preparation"],
          cache: false,
        };
        configuration.tasks["//#test:heavy"]!.dependsOn = ["//#prepare"];
      },
      expected: "prepared\nheavy\n",
      success: true,
    },
    {
      name: "修复入口只选择修复任务",
      gate: "fix",
      configure: (manifest, configuration) => {
        manifest.scripts["lint:fix"] = "node scripts/record.ts repaired";
        configuration.tasks["//#lint:fix"] = {
          tags: ["work:repair"],
          cache: false,
        };
      },
      expected: "repaired\n",
      success: true,
    },
    {
      name: "轻层失败阻止重层启动",
      gate: "check:full",
      configure: (manifest) => {
        manifest.scripts["test:light"] = "node scripts/record.ts light fail";
      },
      expected: "light\n",
      success: false,
    },
    ...[
      { name: "缺失职责", tags: [] },
      { name: "未知职责", tags: ["quality:unknown"] },
      { name: "多重职责", tags: ["quality:light", "quality:heavy"] },
      { name: "验收伪装为按需工作", tags: ["work:on-demand"] },
    ].map(({ name, tags }) => ({
      name,
      gate: "check",
      configure: (
        _manifest: typeof baseManifest,
        configuration: typeof baseConfiguration,
      ) => {
        configuration.tasks["//#test:light"]!.tags = tags;
      },
      expected: "",
      success: false,
    })),
    ...[
      { name: "根委托缺少职责", tags: [] },
      { name: "根委托职责未知", tags: ["work:unknown"] },
      {
        name: "根委托职责冲突",
        tags: ["work:preparation", "quality:light"],
      },
    ].map(({ name, tags }) => ({
      name,
      gate: "check",
      configure: (
        _manifest: typeof baseManifest,
        configuration: typeof baseConfiguration,
      ) => {
        configuration.tasks["development:controlled"]!.tags = tags;
      },
      expected: "",
      success: false,
    })),
    {
      name: "委托目标没有所属Turbo任务",
      gate: "check",
      configure: (
        _manifest,
        _configuration,
        _automationManifest,
        automationConfiguration,
      ) => {
        delete automationConfiguration.tasks["development:controlled"];
      },
      expected: "",
      success: false,
    },
    {
      name: "委托叶任务缺少命令",
      gate: "check",
      configure: (_manifest, _configuration, automationManifest) => {
        delete automationManifest.scripts["development:controlled"];
      },
      expected: "",
      success: false,
    },
    {
      name: "委托叶职责不匹配",
      gate: "check",
      configure: (
        _manifest,
        _configuration,
        _automationManifest,
        automationConfiguration,
      ) => {
        automationConfiguration.tasks["development:controlled"]!.tags = [
          "work:development",
        ];
      },
      expected: "",
      success: false,
    },
    {
      name: "根任务不得重新注册为可执行任务",
      gate: "check",
      configure: (_manifest, configuration) => {
        configuration.tasks["//#development:controlled"] = {
          tags: ["work:preparation"],
          cache: false,
        };
      },
      expected: "",
      success: false,
    },
    {
      name: "委托叶配置不得集中注册在根配置",
      gate: "check",
      configure: (_manifest, configuration) => {
        configuration.tasks[
          "@digital/workspace-automation#development:controlled"
        ] = {
          tags: ["work:preparation"],
        };
      },
      expected: "",
      success: false,
    },
    {
      name: "委托命令不得追加shell步骤",
      gate: "check",
      configure: (manifest) => {
        manifest.scripts["development:controlled"] += " && echo extra";
      },
      expected: "",
      success: false,
    },
    {
      name: "委托入口不能附加其他Turbo目标",
      gate: "check",
      configure: (manifest) => {
        manifest.scripts["development:controlled"] += " --filter=@fixture/tui";
      },
      expected: "",
      success: false,
    },
    {
      name: "公共命令接线错误",
      gate: "check",
      configure: (manifest) => {
        manifest.scripts["check:full"] = "node scripts/record.ts bypassed";
      },
      expected: "",
      success: false,
    },
    {
      name: "带职责的空聚合",
      gate: "check",
      configure: (_manifest, configuration) => {
        configuration.tasks["//#verify:empty"] = { tags: ["quality:light"] };
      },
      expected: "",
      success: false,
    },
    {
      name: "根 generic 任务不能掩盖包级显式空聚合",
      gate: "check",
      configure: (
        _manifest,
        configuration,
        _automationManifest,
        automationConfiguration,
      ) => {
        configuration.tasks["test:probe"] = {};
        automationConfiguration.tasks["test:probe"] = {
          tags: ["quality:heavy"],
        };
      },
      expected: "",
      success: false,
    },
    {
      name: "其他 generic 空任务仍验证职责而不作为委托占位排除",
      gate: "check",
      configure: (_manifest, configuration) => {
        configuration.tasks["test:probe"] = { tags: ["quality:unknown"] };
      },
      expected: "",
      success: false,
    },
    {
      name: "轻层依赖重层",
      gate: "check",
      configure: (_manifest, configuration) => {
        configuration.tasks["//#test:light"]!.dependsOn = ["//#test:heavy"];
      },
      expected: "",
      success: false,
    },
    {
      name: "完整门禁先预检重层，非法条件依赖使轻层也不启动",
      gate: "check:full",
      configure: (_manifest, configuration) => {
        configuration.tasks["//#test:heavy"]!.dependsOn = [
          "//#test:conditional",
        ];
      },
      expected: "",
      success: false,
    },
    {
      name: "任务闭包回流公共聚合入口",
      gate: "check",
      configure: (_manifest, configuration) => {
        configuration.tasks["//#test:light"]!.dependsOn = ["//#check"];
      },
      expected: "",
      success: false,
    },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const manifest = structuredClone(baseManifest);
      const configuration = structuredClone(baseConfiguration);
      const automationManifest = structuredClone(baseAutomationManifest);
      const automationConfiguration = structuredClone(
        baseAutomationConfiguration,
      );
      const tuiConfiguration = structuredClone(baseTuiConfiguration);
      scenario.configure(
        manifest,
        configuration,
        automationManifest,
        automationConfiguration,
        tuiConfiguration,
      );
      await writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify(manifest),
      );
      await writeFile(
        path.join(workspace, "packages/automation/package.json"),
        JSON.stringify(automationManifest),
      );
      await writeFile(
        path.join(workspace, "turbo.json"),
        JSON.stringify(configuration),
      );
      await writeFile(
        path.join(workspace, "packages/automation/turbo.json"),
        JSON.stringify(automationConfiguration),
      );
      await writeFile(
        path.join(workspace, "packages/tui/turbo.json"),
        JSON.stringify(tuiConfiguration),
      );
      await writeFile(path.join(workspace, "ran.txt"), "");
      await writeFile(path.join(workspace, "tui-builds.txt"), "");
      await writeFile(path.join(workspace, "controlled-invocations.txt"), "");
      const execution = spawnSync("pnpm", ["run", scenario.gate], {
        cwd: workspace,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(execution.error, undefined);
      if (scenario.success)
        assert.equal(execution.status, 0, execution.stdout + execution.stderr);
      else
        assert.notEqual(
          execution.status,
          0,
          execution.stdout + execution.stderr,
        );
      assert.equal(
        await readFile(path.join(workspace, "ran.txt"), "utf8"),
        scenario.expected,
      );
      if (!scenario.success && scenario.expected === "") {
        assert.equal(
          await readFile(path.join(workspace, "tui-builds.txt"), "utf8"),
          "",
        );
        assert.equal(
          await readFile(
            path.join(workspace, "controlled-invocations.txt"),
            "utf8",
          ),
          "",
        );
      }
    });
  }
});
