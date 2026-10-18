/** CI 只组合既有入口、公共停止/删除与上传交接；不拥有产品断言。 */
import { spawn } from "node:child_process";
import {
  appendFile,
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  deleteEnvironment,
  inspectEnvironment,
  stopEnvironment,
} from "@digital/environment";
import { manageContainerEnvironment } from "@digital/environment/container";

import { requireInput } from "./inputs.ts";

type Owner = { workspacePath: string; environment: string };
type Collection = {
  owners: Owner[];
  containerOwners: Owner[];
  saveErrors: string[];
  cleanupErrors: string[];
  collected: string[];
};
const workspacePath = requireInput("DIGITAL_AUTOMATION_WORKSPACE");
const [phase, ...extraArguments] = process.argv.slice(2);
if (extraArguments.length > 0)
  throw new Error("用法：ci-environment.ts <run|collect|delete|result>");
const evidence = path.resolve(
  process.env.DIGITAL_CI_EVIDENCE ??
    path.join(workspacePath, ".scratch", "ci", "full"),
);
const containerLedger = path.join(evidence, "container-owners.ndjson");
const privateValues = Object.entries(process.env)
  .filter(
    ([name, value]) =>
      /TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|API_KEY/iu.test(name) &&
      (value?.length ?? 0) > 0,
  )
  .map(([, value]) => value!);
function redact(text: string): string {
  for (const value of privateValues)
    text = text.replaceAll(value, "[REDACTED]");
  return text
    .replace(/(Bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/((?:authorization|cookie)\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(
      /([?&](?:api[-_]?key|token|secret|credential)=)[^&\s]+/giu,
      "$1[REDACTED]",
    );
}
async function save(name: string, value: unknown): Promise<void> {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(evidence, name),
    redact(`${JSON.stringify(value, null, 2)}\n`),
  );
}
function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(evidence, name), "utf8")) as T;
}

async function run(): Promise<number> {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const initial = await environmentNames();
  if (initial.length !== 0)
    throw new Error("CI 需要独占的新检出；发现既有环境，不认领它们");
  await save("initial-environments.json", {
    workspacePath,
    names: initial,
    observedAt: new Date().toISOString(),
  });
  const command = process.execPath;
  const args = [
    "--conditions=digital-source",
    "scripts/task-gates.ts",
    "check:full",
  ];
  const startedAt = new Date().toISOString();
  await save("execution.json", {
    workspacePath,
    command,
    args,
    startedAt,
    exitCode: null,
    signal: null,
    completed: false,
  });
  const childEnvironment = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "TERM",
      "CI",
      "TURBO_CONCURRENCY",
      "COREPACK_HOME",
      "PNPM_HOME",
      "PLAYWRIGHT_BROWSERS_PATH",
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_BUILDKIT",
      "BUILDKIT_PROGRESS",
      "DIGITAL_DEPLOYMENT_BUILD_NETWORK",
    ].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]!]],
    ),
  );
  const child = spawn(command, args, {
    cwd: workspacePath,
    env: { ...childEnvironment, DIGITAL_CI_EVIDENCE: evidence },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let interrupted: string | null = null;
  const onInt = () => {
    interrupted = "SIGINT";
    child.kill("SIGINT");
  };
  const onTerm = () => {
    interrupted = "SIGTERM";
    child.kill("SIGTERM");
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let writing = Promise.resolve();
  const logErrors: string[] = [];
  for (const [stream, label] of [
    [child.stdout, "stdout"],
    [child.stderr, "stderr"],
  ] as const) {
    stream.setEncoding("utf8");
    let pending = "";
    const emit = (text: string) => {
      const safe = redact(text);
      process[label].write(safe);
      writing = writing
        .then(() => appendFile(path.join(evidence, `${label}.log`), safe))
        .catch((error) => {
          logErrors.push(errorText(error));
        });
    };
    stream.on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      if (lines.length > 0) emit(lines.join("\n") + "\n");
    });
    stream.on("end", () => {
      if (pending.length > 0) emit(pending);
    });
  }
  let spawnError: string | null = null;
  child.on("error", (error) => {
    spawnError = errorText(error);
  });
  const result = await new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolve) =>
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal })),
  );
  await writing;
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);
  await save("execution.json", {
    workspacePath,
    command,
    args,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...result,
    interrupted,
    spawnError,
    logErrors,
    completed: true,
  });
  return result.exitCode === 0 && interrupted === null && logErrors.length === 0
    ? 0
    : 1;
}

async function containerOwners(errors: string[]): Promise<Owner[]> {
  let lines: string;
  try {
    lines = await readFile(containerLedger, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result = new Map<string, Owner>();
  for (const line of lines.split("\n").filter(Boolean)) {
    try {
      const owner = JSON.parse(line) as Owner;
      if (
        owner.workspacePath !== workspacePath ||
        !/^(?:completion-(?:15|16)|ewc22)-[A-Za-z0-9._-]+$/u.test(
          owner.environment,
        )
      )
        throw new Error("容器交接归属不属于本作业工作区");
      result.set(owner.environment, owner);
    } catch (error) {
      errors.push(`容器交接记录: ${errorText(error)}`);
    }
  }
  return [...result.values()];
}

async function owners(containers: readonly Owner[]): Promise<Owner[]> {
  const initial = await readJson<{ workspacePath: string; names: string[] }>(
    "initial-environments.json",
  );
  if (initial.workspacePath !== workspacePath || initial.names.length !== 0)
    throw new Error("缺少独占工作区的空初态，不能认领检查环境");
  const containerNames = new Set(containers.map((owner) => owner.environment));
  return (await environmentNames())
    .filter((name) => !containerNames.has(name))
    .map((environment) => ({ workspacePath, environment }));
}

async function environmentNames(): Promise<string[]> {
  try {
    return (
      await readdir(path.join(workspacePath, ".digital", "environments"), {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function collect(): Promise<number> {
  const saveErrors: string[] = [];
  try {
    const execution = await readJson<{
      completed: boolean;
      logErrors?: string[];
    }>("execution.json");
    if (!execution.completed) saveErrors.push("执行层完整日志保存状态未确认");
    for (const error of execution.logErrors ?? [])
      saveErrors.push(`执行日志保存: ${error}`);
  } catch (error) {
    saveErrors.push(`执行记录保存状态: ${errorText(error)}`);
  }
  const containers = await containerOwners(saveErrors);
  const result: Collection = {
    owners: await owners(containers),
    containerOwners: containers,
    saveErrors,
    cleanupErrors: [],
    collected: [],
  };
  // 停止与保存独立：任一复制失败不阻止其他自有环境的公共 stop。
  for (const owner of result.owners) {
    let stopped: Awaited<ReturnType<typeof stopEnvironment>> | undefined;
    let observed: Awaited<ReturnType<typeof inspectEnvironment>> | undefined;
    let before: Awaited<ReturnType<typeof inspectEnvironment>> | undefined;
    try {
      before = await inspectEnvironment(owner);
      if (
        before.status !== "ok" ||
        before.environment.workspacePath !== workspacePath ||
        before.state === "unmanaged"
      )
        throw new Error("公开查看未确认本工作区管理归属");
      stopped = await stopEnvironment(owner);
    } catch (error) {
      result.cleanupErrors.push(
        `${owner.environment} stop: ${errorText(error)}`,
      );
    }
    try {
      observed = await inspectEnvironment(owner);
    } catch (error) {
      result.cleanupErrors.push(
        `${owner.environment} inspect: ${errorText(error)}`,
      );
    }
    const absent =
      observed?.status === "ok" &&
      observed.state === "unprepared" &&
      observed.run.processLiveness === "absent";
    const stoppedConfirmed =
      observed?.status === "ok" &&
      ["exited", "absent"].includes(observed.run.processLiveness) &&
      observed.serviceReadiness !== "ready" &&
      observed.serviceReadiness !== "unknown" &&
      (stopped?.status === "stopped" || stopped?.status === "already-stopped");
    if (!absent && !stoppedConfirmed)
      result.cleanupErrors.push(`${owner.environment} 停止或独立退出未确认`);
    if (stopped !== undefined)
      result.cleanupErrors.push(
        ...stopped.cleanup.errors.map(
          (error) => `${owner.environment}: ${error}`,
        ),
      );
    try {
      await save(`${owner.environment}-stopped.json`, { stopped, observed });
    } catch (error) {
      result.saveErrors.push(
        `${owner.environment} 停止结果: ${errorText(error)}`,
      );
    }
    const target = path.join(evidence, "environments", owner.environment);
    // 日志独立尽力保存；停止未知时也保留公开诊断，不在线复制数据。
    const diagnostic = observed ?? before;
    const logs = new Set(stopped?.logs.files ?? []);
    for (const operation of diagnostic?.operations ?? []) {
      try {
        for (const entry of await readdir(operation.logDirectory, {
          withFileTypes: true,
        }))
          if (entry.isFile())
            logs.add(path.join(operation.logDirectory, entry.name));
      } catch (error) {
        result.saveErrors.push(
          `${owner.environment} 操作日志枚举: ${errorText(error)}`,
        );
      }
    }
    if (diagnostic?.run.productLogFile) logs.add(diagnostic.run.productLogFile);
    const savedLogs: string[] = [];
    for (const [index, file] of [...logs].entries()) {
      try {
        await mkdir(target, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(target, `${index}-${path.basename(file)}`),
          redact(await readFile(file, "utf8")),
        );
        savedLogs.push(file);
      } catch (error) {
        result.saveErrors.push(
          `${owner.environment} 日志收集: ${errorText(error)}`,
        );
      }
    }
    try {
      await save(`${owner.environment}-collected-logs.json`, {
        files: savedLogs,
        attempted: [...logs],
      });
    } catch (error) {
      result.saveErrors.push(
        `${owner.environment} 日志索引: ${errorText(error)}`,
      );
    }
    if (absent || !stoppedConfirmed || observed === undefined) continue;
    try {
      await mkdir(target, { recursive: true, mode: 0o700 });
      // 产品完全退出后复制整个约定数据根；不用在线库复制或容器 export 代替。
      await cp(
        observed.environment.productDataRoot,
        path.join(target, "product-data"),
        {
          recursive: true,
          errorOnExist: true,
          force: false,
        },
      );
      result.collected.push(owner.environment);
    } catch (error) {
      result.saveErrors.push(
        `${owner.environment} 数据收集: ${errorText(error)}`,
      );
    }
  }
  for (const owner of containers) {
    let stopped:
      | Awaited<ReturnType<typeof manageContainerEnvironment>>
      | undefined;
    let observed:
      | Awaited<ReturnType<typeof manageContainerEnvironment>>
      | undefined;
    try {
      stopped = await manageContainerEnvironment({ ...owner, action: "stop" });
    } catch (error) {
      result.cleanupErrors.push(
        `${owner.environment} stop: ${errorText(error)}`,
      );
    }
    try {
      observed = await manageContainerEnvironment({
        ...owner,
        action: "inspect",
      });
    } catch (error) {
      result.cleanupErrors.push(
        `${owner.environment} inspect: ${errorText(error)}`,
      );
    }
    for (const operation of [stopped, observed]) {
      result.cleanupErrors.push(...(operation?.cleanupErrors ?? []));
      result.saveErrors.push(...(operation?.saveErrors ?? []));
    }
    try {
      await save(`${owner.environment}-stopped.json`, { stopped, observed });
    } catch (error) {
      result.saveErrors.push(
        `${owner.environment} 停止结果: ${errorText(error)}`,
      );
    }
    if (
      stopped?.status !== "ok" ||
      observed?.status !== "ok" ||
      observed.observation?.objects.some(
        (object) => object.running === true || object.state === "unknown",
      )
    ) {
      result.cleanupErrors.push(
        `${owner.environment}: 容器停止或独立退出未确认`,
      );
      continue;
    }
    if (observed.remaining.length === 0 && !observed.observation?.dataPresent)
      continue;
    let saved:
      | Awaited<ReturnType<typeof manageContainerEnvironment>>
      | undefined;
    try {
      saved = await manageContainerEnvironment({
        ...owner,
        action: "save",
        includeData: true,
        directory: path.join(evidence, "containers", owner.environment),
      });
      result.saveErrors.push(...saved.saveErrors);
      result.cleanupErrors.push(...saved.cleanupErrors);
      if (saved.status !== "ok" || saved.evidence?.dataSaved !== true)
        result.saveErrors.push(
          `${owner.environment}: 容器数据及日志未完整保存`,
        );
      else result.collected.push(owner.environment);
    } catch (error) {
      result.saveErrors.push(
        `${owner.environment} 容器数据及日志: ${errorText(error)}`,
      );
    }
    try {
      await save(`${owner.environment}-collected.json`, saved);
    } catch (error) {
      result.saveErrors.push(
        `${owner.environment} 收集结果: ${errorText(error)}`,
      );
    }
  }
  await save("collection.json", result);
  return result.cleanupErrors.length === 0 && result.saveErrors.length === 0
    ? 0
    : 1;
}

async function remove(): Promise<number> {
  const collection = await readJson<Collection>("collection.json");
  if (collection.saveErrors.length > 0 || collection.cleanupErrors.length > 0)
    throw new Error("保存或停止未确认，保留原载体，不删除");
  const id = process.env.DIGITAL_CI_ARTIFACT_ID;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!id || !repository || !process.env.GITHUB_TOKEN)
    throw new Error("未取得实际上传 ID 与核验上下文，保留载体");
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/artifacts/${id}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok)
    throw new Error(`上传产物核验失败：HTTP ${response.status}`);
  const artifact = (await response.json()) as {
    id: number;
    name: string;
    expired: boolean;
    size_in_bytes: number;
    workflow_run?: { id: number };
    digest?: string;
  };
  if (
    String(artifact.id) !== id ||
    artifact.name !== process.env.DIGITAL_CI_ARTIFACT_NAME ||
    artifact.expired ||
    artifact.size_in_bytes <= 0 ||
    String(artifact.workflow_run?.id) !== process.env.GITHUB_RUN_ID
  )
    throw new Error("上传产物 ID、名称、运行归属或有效字节未核实");
  await save("artifact-verified.json", artifact);
  const results: unknown[] = [];
  let failed = false;
  for (const owner of collection.owners) {
    try {
      // 删除前再做公开独立观察；收集后意外重启时不会删除正在写入的数据。
      const before = await inspectEnvironment(owner);
      if (
        before.status !== "ok" ||
        !["exited", "absent"].includes(before.run.processLiveness) ||
        before.serviceReadiness === "ready" ||
        before.serviceReadiness === "unknown"
      )
        throw new Error("删除前退出状态未确认");
      const deletion = await deleteEnvironment(owner);
      const after = await inspectEnvironment(owner);
      results.push({ owner, before, deletion, after });
      if (
        !["deleted", "already-deleted"].includes(deletion.status) ||
        deletion.cleanup.errors.length > 0 ||
        after.state !== "unprepared" ||
        after.run.processLiveness !== "absent"
      )
        failed = true;
    } catch (error) {
      failed = true;
      results.push({ owner, error: errorText(error) });
    }
  }
  for (const owner of collection.containerOwners) {
    try {
      const before = await manageContainerEnvironment({
        ...owner,
        action: "inspect",
      });
      if (
        before.status !== "ok" ||
        before.observation?.objects.some(
          (object) => object.running === true || object.state === "unknown",
        )
      )
        throw new Error("容器删除前退出状态未确认");
      const deletion = await manageContainerEnvironment({
        ...owner,
        action: "delete",
        deleteData: true,
      });
      const after = await manageContainerEnvironment({
        ...owner,
        action: "inspect",
      });
      results.push({ owner, before, deletion, after });
      if (
        deletion.status !== "ok" ||
        deletion.cleanupErrors.length > 0 ||
        after.status !== "ok" ||
        after.remaining.length > 0 ||
        after.observation?.dataPresent
      )
        failed = true;
    } catch (error) {
      failed = true;
      results.push({ owner, error: errorText(error) });
    }
  }
  await save("deletion.json", { artifactId: id, results, failed });
  // 删除发生在上传之后，后续结果还须进入可下载的实际作业日志。
  console.log(
    redact(
      JSON.stringify({ phase: "delete", artifactId: id, results, failed }),
    ),
  );
  return failed ? 1 : 0;
}

async function result(): Promise<number> {
  const outcomes = {
    execution: process.env.DIGITAL_CI_EXECUTION_OUTCOME,
    collection: process.env.DIGITAL_CI_COLLECTION_OUTCOME,
    upload: process.env.DIGITAL_CI_UPLOAD_OUTCOME,
    deletion: process.env.DIGITAL_CI_DELETION_OUTCOME,
  };
  console.log(JSON.stringify(outcomes));
  return Object.values(outcomes).every((value) => value === "success") ? 0 : 1;
}

try {
  process.exitCode =
    phase === "run"
      ? await run()
      : phase === "collect"
        ? await collect()
        : phase === "delete"
          ? await remove()
          : phase === "result"
            ? await result()
            : (() => {
                throw new Error("未知 CI 阶段");
              })();
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
}
