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
  const baseConfiguration = JSON.parse(
    await readFile(path.join(workspace, "turbo.json"), "utf8"),
  ) as { tasks: Record<string, Task> };

  const scenarios: {
    name: string;
    gate: string;
    configure: (
      manifest: typeof baseManifest,
      configuration: typeof baseConfiguration,
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
      scenario.configure(manifest, configuration);
      await writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify(manifest),
      );
      await writeFile(
        path.join(workspace, "turbo.json"),
        JSON.stringify(configuration),
      );
      await writeFile(path.join(workspace, "ran.txt"), "");
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
    });
  }
});
