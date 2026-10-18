import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runVisible } from "./turbo-process.ts";

export type TaskGate = "check" | "check:heavy" | "check:full" | "fix";

const rootControlledDelegateTaskName = "development:controlled";

type ScriptRole =
  | "quality:light"
  | "quality:heavy"
  | "quality:conditional"
  | "quality:entry"
  | "work:development"
  | "work:repair"
  | "work:release"
  | "work:preparation"
  | "work:lifecycle"
  | "work:on-demand";

type TurboTask = {
  readonly name: string;
  readonly fullName: string;
  readonly packageName: string;
  readonly tags: readonly string[];
  readonly executable: boolean;
  readonly role?: ScriptRole;
};

type GateLayer = {
  readonly role: "quality:light" | "quality:heavy" | "work:repair";
  readonly label: string;
};

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
};

const turboTaskQuery =
  "{ packages { items { name path tasks { items { name fullName tags script command } } } } }";

const validRoles = new Set<ScriptRole>([
  "quality:light",
  "quality:heavy",
  "quality:conditional",
  "quality:entry",
  "work:development",
  "work:repair",
  "work:release",
  "work:preparation",
  "work:lifecycle",
  "work:on-demand",
]);

const publicGateNames = new Set<TaskGate>([
  "check",
  "check:heavy",
  "check:full",
  "fix",
]);

const maxTurboOutputBytes = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function report(message: string): void {
  process.stderr.write(`${message}\n`);
}

function runCaptured(cwd: string, args: readonly string[]): CommandResult {
  const result = spawnSync("pnpm", ["exec", "turbo", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: maxTurboOutputBytes,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function commandFailure(label: string, result: CommandResult): string {
  const details = result.stderr.trim();
  if (result.error !== undefined) {
    return `无法运行 Turbo ${label}：${result.error.message}`;
  }
  return `Turbo ${label} 失败（退出码 ${String(result.status)}）${details === "" ? "" : `：\n${details}`}`;
}

function roleTags(tags: readonly string[]): readonly string[] {
  return tags.filter(
    (tag) => tag.startsWith("quality:") || tag.startsWith("work:"),
  );
}

function publicGateTask(task: {
  readonly name: string;
  readonly packageName: string;
}): boolean {
  return (
    task.packageName === "//" && publicGateNames.has(task.name as TaskGate)
  );
}

function protectedVerificationTask(task: TurboTask): boolean {
  return (
    task.name === "check" ||
    task.name.startsWith("check:") ||
    task.name === "test" ||
    task.name.startsWith("test:") ||
    task.name === "lint" ||
    task.name === "typecheck" ||
    task.name === "format:check"
  );
}

function assignRole(
  task: Omit<TurboTask, "role">,
  diagnostics: string[],
): ScriptRole | undefined {
  const roles = roleTags(task.tags);
  const isPublicGate = publicGateTask(task);
  if (roles.length === 0) {
    diagnostics.push(
      `${task.fullName} 缺少唯一职责标签；请在 Turbo 任务标签中声明质量范围或工作用途`,
    );
    return undefined;
  }
  if (roles.length > 1) {
    diagnostics.push(
      `${task.fullName} 有多个职责标签：${roles.join("、")}；每个可执行任务只能声明一个职责`,
    );
    return undefined;
  }

  const role = roles[0]!;
  if (!validRoles.has(role as ScriptRole)) {
    diagnostics.push(`${task.fullName} 使用未知职责标签 ${role}`);
    return undefined;
  }
  const scriptRole = role as ScriptRole;
  const publicRole = task.name === "fix" ? "work:repair" : "quality:entry";
  if (isPublicGate && scriptRole !== publicRole) {
    diagnostics.push(
      `${task.fullName} 是公共任务入口，职责必须为 ${publicRole}，当前为 ${scriptRole}`,
    );
    return undefined;
  }
  if (!isPublicGate && scriptRole === "quality:entry") {
    diagnostics.push(
      `${task.fullName} 不能使用 quality:entry；该职责只允许根 check、check:heavy、check:full`,
    );
    return undefined;
  }
  if (protectedVerificationTask(task) && !scriptRole.startsWith("quality:")) {
    diagnostics.push(
      `${task.fullName} 是保留验收任务，不能归入非验收职责 ${scriptRole}`,
    );
    return undefined;
  }

  return scriptRole;
}

function roleFromTaskDefinition(
  taskDefinitions: Record<string, unknown>,
  name: string,
  diagnostics: string[],
): ScriptRole | undefined {
  const definition = taskDefinitions[name];
  if (!isRecord(definition)) {
    diagnostics.push(`${name} 缺少 Turbo 原生职责声明`);
    return undefined;
  }
  const tags = definition.tags;
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    diagnostics.push(`${name} Turbo 原生职责标签无效`);
    return undefined;
  }
  const roles = roleTags(tags);
  if (roles.length === 0) {
    diagnostics.push(
      `${name} 缺少唯一职责标签；请在 Turbo 任务标签中声明工作用途`,
    );
    return undefined;
  }
  if (roles.length > 1) {
    diagnostics.push(`${name} 有多个职责标签：${roles.join("、")}`);
    return undefined;
  }
  const role = roles[0] as ScriptRole;
  if (!validRoles.has(role)) {
    diagnostics.push(`${name} 使用未知职责标签 ${roles[0]}`);
    return undefined;
  }
  return role;
}

function assignRootControlledDelegateRole(
  task: Omit<TurboTask, "role">,
  script: string | undefined,
  command: string | undefined,
  pending: readonly {
    readonly task: Omit<TurboTask, "role">;
    readonly script: string | undefined;
    readonly command: string | undefined;
  }[],
  taskDefinitions: Record<string, unknown>,
  packageTaskDefinitions: ReadonlyMap<string, Record<string, unknown>>,
  taskRoles: ReadonlyMap<string, ScriptRole | undefined>,
  diagnostics: string[],
): ScriptRole | undefined {
  const rootTaskName = task.name;
  if (!task.executable) {
    diagnostics.push(`${task.fullName} 根委托入口缺少可执行命令`);
  }
  const rootSpecificName = `//#${rootTaskName}`;
  if (Object.hasOwn(taskDefinitions, rootSpecificName)) {
    diagnostics.push(
      `${rootSpecificName} 不能注册可执行根任务；根命令只委托给所属叶任务`,
    );
  }

  const rootRole = roleFromTaskDefinition(
    taskDefinitions,
    rootTaskName,
    diagnostics,
  );
  if (rootRole !== "work:preparation") {
    diagnostics.push(
      `${rootTaskName} 根委托职责必须是 work:preparation，当前为 ${String(rootRole)}`,
    );
  }

  const candidates = pending.filter(
    (entry) =>
      entry.task.packageName !== "//" &&
      entry.task.name === rootTaskName &&
      Object.hasOwn(
        packageTaskDefinitions.get(entry.task.packageName) ?? {},
        rootTaskName,
      ),
  );
  if (candidates.length === 0) {
    diagnostics.push(`${rootTaskName} 根委托目标不存在`);
    return rootRole;
  }
  if (candidates.length > 1) {
    diagnostics.push(
      `${rootTaskName} 根委托目标必须唯一，当前有 ${String(candidates.length)} 个叶任务`,
    );
    return rootRole;
  }

  const candidate = candidates[0]!;
  if (Object.hasOwn(taskDefinitions, candidate.task.fullName)) {
    diagnostics.push(
      `${candidate.task.fullName} 叶任务定义必须归所属包 Turbo 配置，不能集中注册在根配置`,
    );
  }
  const candidateRole = taskRoles.get(candidate.task.fullName);
  if (!candidate.task.executable) {
    diagnostics.push(`${candidate.task.fullName} 叶任务缺少可执行命令`);
  }
  if (candidateRole !== rootRole || candidateRole !== "work:preparation") {
    diagnostics.push(
      `${candidate.task.fullName} 叶职责必须与根委托一致且为 work:preparation，当前为 ${String(candidateRole)}`,
    );
  }

  const leafRole = roleFromTaskDefinition(
    packageTaskDefinitions.get(candidate.task.packageName) ?? {},
    rootTaskName,
    diagnostics,
  );
  if (leafRole !== rootRole || leafRole !== "work:preparation") {
    diagnostics.push(
      `${candidate.task.fullName} 所属 Turbo 职责必须与根委托一致且为 work:preparation，当前为 ${String(leafRole)}`,
    );
  }

  if (candidate.task.packageName !== "@digital/workspace-automation") {
    diagnostics.push(
      `${task.fullName} 委托实现固定选择 @digital/workspace-automation 叶任务，实际目标为 ${candidate.task.packageName}`,
    );
  }

  const expectedCommand =
    'DIGITAL_AUTOMATION_WORKSPACE="$PWD" node --conditions=digital-source scripts/controlled-development.ts';
  if (script !== expectedCommand || command !== expectedCommand) {
    diagnostics.push(
      `${task.fullName} 必须精确委托给 ${candidate.task.packageName} 的单一 Turbo 叶任务`,
    );
  }

  return rootRole;
}

function readTaskDirectory(
  cwd: string,
  entryCommand: string,
): {
  readonly tasks: readonly TurboTask[];
  readonly diagnostics: readonly string[];
} {
  const result = runCaptured(cwd, ["query", turboTaskQuery]);
  if (result.error !== undefined || result.status !== 0) {
    return {
      diagnostics: [commandFailure("原生任务目录查询", result)],
      tasks: [],
    };
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        `Turbo 原生任务目录不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      ],
      tasks: [],
    };
  }

  const packages =
    isRecord(response) && isRecord(response.data)
      ? response.data.packages
      : undefined;
  const packageItems = isRecord(packages) ? packages.items : undefined;
  if (!Array.isArray(packageItems)) {
    return {
      diagnostics: ["Turbo 原生任务目录缺少 packages.items"],
      tasks: [],
    };
  }

  const diagnostics: string[] = [];
  let taskDefinitions: Record<string, unknown>;
  try {
    const configuration: unknown = JSON.parse(
      readFileSync(resolve(cwd, "turbo.json"), "utf8"),
    );
    if (!isRecord(configuration) || !isRecord(configuration.tasks)) {
      return {
        diagnostics: ["Turbo 原生配置缺少 tasks"],
        tasks: [],
      };
    }
    taskDefinitions = configuration.tasks;
  } catch (error) {
    return {
      diagnostics: [
        `无法读取 Turbo 原生任务声明：${error instanceof Error ? error.message : String(error)}`,
      ],
      tasks: [],
    };
  }

  const pending: {
    readonly task: Omit<TurboTask, "role">;
    readonly script: string | undefined;
    readonly command: string | undefined;
  }[] = [];
  const packageTaskDefinitions = new Map<string, Record<string, unknown>>();
  for (const packageItem of packageItems) {
    if (
      !isRecord(packageItem) ||
      !isNonEmptyString(packageItem.name) ||
      typeof packageItem.path !== "string"
    ) {
      diagnostics.push("Turbo 原生任务目录包含无法识别的工作区包");
      continue;
    }
    if (packageItem.name === "//") {
      packageTaskDefinitions.set(packageItem.name, taskDefinitions);
    } else {
      const packageTurboPath = resolve(cwd, packageItem.path, "turbo.json");
      if (!existsSync(packageTurboPath)) {
        packageTaskDefinitions.set(packageItem.name, {});
      } else {
        try {
          const packageConfiguration: unknown = JSON.parse(
            readFileSync(packageTurboPath, "utf8"),
          );
          if (
            !isRecord(packageConfiguration) ||
            !isRecord(packageConfiguration.tasks)
          ) {
            diagnostics.push(`${packageItem.name} 所属 Turbo 配置缺少 tasks`);
            packageTaskDefinitions.set(packageItem.name, {});
          } else {
            packageTaskDefinitions.set(
              packageItem.name,
              packageConfiguration.tasks,
            );
          }
        } catch (error) {
          diagnostics.push(
            `无法读取 ${packageItem.name} 所属 Turbo 配置：${error instanceof Error ? error.message : String(error)}`,
          );
          packageTaskDefinitions.set(packageItem.name, {});
        }
      }
    }
    const taskConnection = packageItem.tasks;
    const taskItems = isRecord(taskConnection)
      ? taskConnection.items
      : undefined;
    if (!Array.isArray(taskItems)) {
      diagnostics.push(`${packageItem.name} 的 Turbo 任务目录缺少 tasks.items`);
      continue;
    }

    for (const taskItem of taskItems) {
      if (!isRecord(taskItem)) {
        diagnostics.push(`${packageItem.name} 的 Turbo 任务目录包含无效任务`);
        continue;
      }
      const { name, fullName, tags, script, command } = taskItem;
      if (
        !isNonEmptyString(name) ||
        !isNonEmptyString(fullName) ||
        !Array.isArray(tags) ||
        !tags.every((tag) => typeof tag === "string")
      ) {
        diagnostics.push(`${packageItem.name} 的 Turbo 任务条目缺少名称或标签`);
        continue;
      }

      const executable = isNonEmptyString(script) || isNonEmptyString(command);
      const taskWithoutRole = {
        name,
        fullName,
        packageName: packageItem.name,
        tags,
        executable,
      };
      if (
        !executable &&
        name === rootControlledDelegateTaskName &&
        Object.hasOwn(taskDefinitions, name) &&
        !Object.hasOwn(taskDefinitions, fullName) &&
        !Object.hasOwn(packageTaskDefinitions.get(packageItem.name) ?? {}, name)
      ) {
        continue;
      }
      if (publicGateTask(taskWithoutRole)) {
        const expectedCommand = `${entryCommand} ${name}`;
        if (script !== expectedCommand || command !== expectedCommand) {
          diagnostics.push(
            `${fullName} 公共入口接线错误；package.json script 和有效 command 必须为 ${expectedCommand}`,
          );
        }
      }
      pending.push({
        task: taskWithoutRole,
        script: isNonEmptyString(script) ? script : undefined,
        command: isNonEmptyString(command) ? command : undefined,
      });
    }
  }

  const taskRoles = new Map<string, ScriptRole | undefined>();
  for (const entry of pending) {
    if (entry.task.packageName === "//") continue;
    if (!entry.task.executable && roleTags(entry.task.tags).length === 0) {
      taskRoles.set(entry.task.fullName, undefined);
      continue;
    }
    taskRoles.set(entry.task.fullName, assignRole(entry.task, diagnostics));
  }
  for (const entry of pending) {
    if (entry.task.packageName !== "//") continue;
    const role =
      entry.task.name === rootControlledDelegateTaskName
        ? assignRootControlledDelegateRole(
            entry.task,
            entry.script,
            entry.command,
            pending,
            taskDefinitions,
            packageTaskDefinitions,
            taskRoles,
            diagnostics,
          )
        : !entry.task.executable && roleTags(entry.task.tags).length === 0
          ? undefined
          : assignRole(entry.task, diagnostics);
    taskRoles.set(entry.task.fullName, role);
  }

  const tasks: TurboTask[] = pending.map((entry) => {
    const role = taskRoles.get(entry.task.fullName);
    return role === undefined ? entry.task : { ...entry.task, role };
  });

  for (const name of publicGateNames) {
    if (
      !tasks.some((task) => task.packageName === "//" && task.name === name)
    ) {
      diagnostics.push(`缺少根公共任务入口 ${name}`);
    }
  }

  return { diagnostics, tasks };
}

function parseDryRun(
  cwd: string,
  tasks: readonly TurboTask[],
): {
  readonly taskIds: readonly string[];
  readonly diagnostics: readonly string[];
} {
  if (tasks.length === 0) {
    return { diagnostics: [], taskIds: [] };
  }
  const result = runCaptured(cwd, [
    "run",
    ...tasks.map((task) => task.fullName),
    "--dry=json",
  ]);
  if (result.error !== undefined || result.status !== 0) {
    return {
      diagnostics: [commandFailure("执行图预览", result)],
      taskIds: [],
    };
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        `Turbo 执行图预览不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      ],
      taskIds: [],
    };
  }
  if (!isRecord(response) || !Array.isArray(response.tasks)) {
    return {
      diagnostics: ["Turbo 执行图预览缺少 tasks"],
      taskIds: [],
    };
  }

  const taskIds: string[] = [];
  const diagnostics: string[] = [];
  for (const task of response.tasks) {
    if (!isRecord(task) || !isNonEmptyString(task.taskId)) {
      diagnostics.push("Turbo 执行图预览包含无法识别的任务标识");
      continue;
    }
    taskIds.push(task.taskId);
  }

  return { diagnostics, taskIds };
}

function validateLayerClosure(
  layer: GateLayer,
  taskIds: readonly string[],
  tasksByName: ReadonlyMap<string, TurboTask>,
): readonly string[] {
  const diagnostics: string[] = [];
  for (const taskId of taskIds) {
    const dependency = tasksByName.get(taskId);
    if (dependency === undefined) {
      diagnostics.push(
        `${layer.label} 执行图包含任务目录中不存在的任务 ${taskId}`,
      );
      continue;
    }
    if (publicGateTask(dependency)) {
      diagnostics.push(
        `${layer.label} 执行图包含 ${dependency.fullName}：叶任务不能依赖公共聚合入口`,
      );
    } else if (
      dependency.role !== undefined &&
      dependency.role !== layer.role &&
      dependency.role !== "work:preparation" &&
      !(layer.role !== "quality:light" && dependency.role === "quality:light")
    ) {
      const scope =
        layer.role === "quality:light" && dependency.role === "quality:heavy"
          ? "轻检查不能间接启动重验收"
          : dependency.role === "quality:conditional"
            ? "常规验收不能间接启动条件验收"
            : `不允许间接启动职责 ${dependency.role}`;
      diagnostics.push(
        `${layer.label} 执行图包含 ${dependency.fullName}：${scope}`,
      );
    }
  }

  return diagnostics;
}

function layerFor(role: GateLayer["role"]): GateLayer {
  return {
    role,
    label:
      role === "quality:light"
        ? "轻检查"
        : role === "quality:heavy"
          ? "重验收"
          : "修复",
  };
}

function layersFor(gate: TaskGate): readonly GateLayer[] {
  if (gate === "check") {
    return [layerFor("quality:light")];
  }
  if (gate === "check:heavy") {
    return [layerFor("quality:heavy")];
  }
  if (gate === "fix") {
    return [layerFor("work:repair")];
  }

  return [layerFor("quality:light"), layerFor("quality:heavy")];
}

export async function runTaskGate(
  gate: TaskGate,
  cwd = process.cwd(),
  entryCommand = "node --conditions=digital-source scripts/task-gates.ts",
): Promise<number> {
  if (!publicGateNames.has(gate)) {
    report(`未知公共任务入口：${String(gate)}`);
    return 1;
  }

  const directory = readTaskDirectory(cwd, entryCommand);
  if (directory.diagnostics.length > 0) {
    report(directory.diagnostics.join("\n"));
    return 1;
  }
  const tasksByName = new Map(
    directory.tasks.map((task) => [task.fullName, task]),
  );
  const layers = layersFor(gate);
  const plans: {
    readonly layer: GateLayer;
    readonly tasks: readonly TurboTask[];
  }[] = [];
  const diagnostics: string[] = [];

  for (const task of directory.tasks) {
    if (task.executable || task.role === undefined) {
      continue;
    }
    const dryRun = parseDryRun(cwd, [task]);
    diagnostics.push(...dryRun.diagnostics);
    if (
      dryRun.diagnostics.length === 0 &&
      !dryRun.taskIds.some(
        (taskId) => tasksByName.get(taskId)?.executable === true,
      )
    ) {
      diagnostics.push(
        `${task.fullName} 声明悬空职责标签 ${task.role}：无命令节点的原生执行图没有可执行工作`,
      );
    }
  }

  for (const layer of layers) {
    const selected = directory.tasks.filter(
      (task) => task.role === layer.role && !publicGateTask(task),
    );
    const dryRun = parseDryRun(cwd, selected);
    diagnostics.push(...dryRun.diagnostics);
    diagnostics.push(
      ...validateLayerClosure(layer, dryRun.taskIds, tasksByName),
    );
    if (
      layer.role === "quality:light" &&
      !dryRun.taskIds.some(
        (taskId) => tasksByName.get(taskId)?.executable === true,
      )
    ) {
      diagnostics.push(
        "轻检查没有选中有效任务；请为实际验收任务声明 quality:light",
      );
    }
    plans.push({ layer, tasks: selected });
  }

  if (diagnostics.length > 0) {
    report(diagnostics.join("\n"));
    return 1;
  }

  const conditionalTasks = directory.tasks.filter(
    (task) => task.role === "quality:conditional",
  );
  if (gate !== "fix" && conditionalTasks.length > 0) {
    report(
      `条件验收未执行：${conditionalTasks.map((task) => task.fullName).join("、")}`,
    );
  }

  for (const plan of plans) {
    if (plan.tasks.length === 0) {
      report(`${plan.layer.label}没有选中任务，跳过执行`);
      continue;
    }
    const status = await runVisible(cwd, [
      "run",
      ...plan.tasks.map((task) => task.fullName),
      "--continue=dependencies-successful",
      gate === "fix" ? "--output-logs=full" : "--output-logs=errors-only",
      "--log-order=grouped",
      "--log-prefix=task",
    ]);
    if (status !== 0) {
      return status;
    }
  }

  return 0;
}

const mainFile = process.argv[1];
if (
  mainFile !== undefined &&
  pathToFileURL(resolve(mainFile)).href === import.meta.url
) {
  const gate = process.argv[2];
  if (
    process.argv.length !== 3 ||
    (gate !== "check" &&
      gate !== "check:heavy" &&
      gate !== "check:full" &&
      gate !== "fix")
  ) {
    report(
      "用法：node scripts/task-gates.ts <check|check:heavy|check:full|fix>",
    );
    process.exitCode = 2;
  } else {
    void runTaskGate(gate)
      .then((status) => {
        process.exitCode = status;
      })
      .catch((error: unknown) => {
        report(
          `公共任务入口失败：${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      });
  }
}
