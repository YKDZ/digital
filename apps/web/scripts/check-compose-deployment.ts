import assert from "node:assert/strict";
import { chmod, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  manageContainerEnvironment,
  type ContainerObject,
  type ContainerOperationResult,
  type ContainerReference,
  type ContainerRequest,
} from "@digital/environment/container";
import {
  createProductClient,
  digestDirectory,
  intakeDirectories,
} from "@digital/test-support/product-client";

import { fileCommandJournal, runCommand } from "./environment-lifecycle.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const uniqueId = `completion-16-${process.pid}-${Date.now()}`;
const artifacts = path.resolve(
  process.env.DIGITAL_COMPOSE_CHECK_ARTIFACTS ??
    `.scratch/deployment/${uniqueId}`,
);
const port = Number(process.env.DIGITAL_COMPOSE_CHECK_PORT ?? "3000");
const uid = Number(process.env.DIGITAL_COMPOSE_CHECK_UID ?? "1001");
const gid = Number(process.env.DIGITAL_COMPOSE_CHECK_GID ?? "1001");
const migrationImage = process.env.DIGITAL_DEPLOYMENT_STANDALONE_IMAGE;
const runtimeImage = process.env.DIGITAL_DEPLOYMENT_RUNTIME_IMAGE;
if (!migrationImage || !runtimeImage)
  throw new Error("必须显式提供已构建的迁移及运行镜像引用");
const endpoint = {
  command: process.env.DIGITAL_DEPLOYMENT_DOCKER_COMMAND ?? "docker",
  arguments: JSON.parse(
    process.env.DIGITAL_DEPLOYMENT_DOCKER_ARGUMENTS ?? "[]",
  ) as string[],
  host: process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock",
};
const observed = path.join(artifacts, "observed");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort(new Error(`收到 ${signal}`)));
const environments: ContainerReference[] = [];
const operations: unknown[] = [];
const saveErrors: string[] = [];
const cleanupErrors: string[] = [];
let mainError: string | undefined;
let saveNumber = 0;

async function saveOperations(): Promise<void> {
  try {
    await writeFile(
      path.join(artifacts, "operations.json"),
      JSON.stringify(
        { operations, mainError, saveErrors, cleanupErrors },
        null,
        2,
      ),
    );
  } catch (error) {
    saveErrors.push(String(error));
    console.error("保存调用方结果失败", error);
  }
}
async function operate(
  request: ContainerRequest,
  cleanup = false,
): Promise<ContainerOperationResult> {
  const startedAt = new Date().toISOString();
  const result = await manageContainerEnvironment(
    request,
    cleanup ? {} : { signal: controller.signal },
  );
  operations.push({
    request,
    startedAt,
    finishedAt: new Date().toISOString(),
    result,
  });
  console.log(
    JSON.stringify({
      environment: request.environment,
      action: request.action,
      status: result.status,
      failure: result.failure,
    }),
  );
  await saveOperations();
  return result;
}
function success(result: ContainerOperationResult): ContainerOperationResult {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result;
}
function web(result: ContainerOperationResult): ContainerObject {
  const object = result.observation?.objects.findLast(
    (item) => item.role === "service" && item.state === "present",
  );
  assert(object?.id);
  return object;
}
async function prepare(
  suffix: string,
  identity = { uid, gid },
): Promise<ContainerReference> {
  const reference = {
    workspacePath: repositoryRoot,
    environment: `${uniqueId}-${suffix}`,
  };
  environments.push(reference);
  success(
    await operate({
      ...reference,
      action: "prepare-compose",
      endpoint,
      image: migrationImage!,
      compose: {
        file: path.join(repositoryRoot, "docker-compose.yml"),
        configuration: {
          DIGITAL_MIGRATION_IMAGE: migrationImage!,
          DIGITAL_RUNTIME_IMAGE: runtimeImage!,
          DIGITAL_UID: String(identity.uid),
          DIGITAL_GID: String(identity.gid),
          DIGITAL_OBSERVED_ROOT_HOST_PATH: observed,
          DIGITAL_BIND_ADDRESS: "127.0.0.1",
          DIGITAL_PORT: String(port),
        },
        services: [
          { name: "migrate", role: "task" },
          { name: "web", role: "service" },
        ],
        dataVariable: "DIGITAL_PRODUCT_DATA_HOST_PATH",
        dataOwner: { uid, gid },
      },
    }),
  );
  return reference;
}
async function up(
  reference: ContainerReference,
): Promise<ContainerOperationResult> {
  const result = success(await operate({ ...reference, action: "compose-up" }));
  const migration = result.observation?.objects.findLast(
    (object) => object.role === "task" && object.state === "present",
  );
  assert.equal(migration?.running, false);
  assert.equal(migration?.exitCode, 0);
  assert.equal(result.observation?.serviceReady, true);
  const service = web(result);
  assert.equal(service.running, true);
  success(
    await operate({
      ...reference,
      action: "wait",
      objectId: service.id!,
      condition: "live",
    }),
  );
  success(
    await operate({
      ...reference,
      action: "wait",
      objectId: service.id!,
      condition: "healthy",
      timeoutMilliseconds: 90_000,
    }),
  );
  return result;
}
async function stop(
  reference: ContainerReference,
  normal: boolean,
): Promise<ContainerOperationResult> {
  const result = success(await operate({ ...reference, action: "stop" }, true));
  assert(
    result.observation?.objects.every((object) => object.running !== true),
  );
  if (normal) {
    const service = web(result);
    assert.equal(service.running, false);
    assert.equal(service.pid, 0);
    assert.equal(service.exitCode, 143);
    assert.equal(service.oomKilled, false);
    assert(
      (service.stopDurationMilliseconds ?? Infinity) < 10_000,
      JSON.stringify(service),
    );
  }
  return result;
}
async function save(reference: ContainerReference): Promise<void> {
  success(
    await operate(
      {
        ...reference,
        action: "save",
        includeData: true,
        directory: path.join(
          artifacts,
          `${reference.environment}-saved-${++saveNumber}`,
        ),
      },
      true,
    ),
  );
}
async function remove(reference: ContainerReference): Promise<void> {
  await save(reference);
  success(
    await operate({ ...reference, action: "delete", deleteData: true }, true),
  );
  success(await operate({ ...reference, action: "stop" }, true));
  const repeated = success(
    await operate({ ...reference, action: "delete", deleteData: true }, true),
  );
  assert.equal(repeated.remaining.length, 0);
  assert.equal(repeated.observation?.dataPresent, false);
}
async function assertOwnersStopped(
  reference: ContainerReference,
  service: ContainerObject,
): Promise<void> {
  const destination = path.join(artifacts, "stopped-web.tar");
  success(
    await operate(
      { ...reference, action: "export", objectId: service.id!, destination },
      true,
    ),
  );
  for (const pattern of [
    "tmp/digital-web-process-*",
    "tmp/digital-fanbox-browser-*",
    "tmp/playwright_chromiumdev_profile-*",
  ]) {
    const result = await runCommand({
      phase: "shutdown-owner",
      command: "tar",
      args: [
        "--list",
        "--file",
        destination,
        "--wildcards",
        "--no-anchored",
        pattern,
      ],
      cwd: repositoryRoot,
      journal: fileCommandJournal(
        path.join(artifacts, "shutdown-commands.ndjson"),
      ),
    });
    assert.equal(
      result.stdoutTail.trim(),
      "",
      `停止后仍有临时 owner：${pattern}`,
    );
    assert(
      result.exitCode === 0 ||
        (result.exitCode === 2 &&
          result.stderrTail.includes("Not found in archive")),
      JSON.stringify(result),
    );
    assert.equal(result.journalError, undefined);
  }
}

try {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await cp(
    path.join(repositoryRoot, "fixtures/controlled-source-io/material"),
    observed,
    { recursive: true },
  );
  await chmod(observed, 0o755);
  const materialsBefore = await digestDirectory(observed);
  const normal = await prepare("normal");
  const started = await up(normal);
  const service = web(started);
  const identity = success(
    await operate({
      ...normal,
      action: "exec",
      objectId: service.id!,
      command: [
        "node",
        "--input-type=module",
        "--eval",
        "import fs from 'node:fs'; console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()})); fs.writeFileSync('/data/compose-write-check','ok'); try {fs.writeFileSync('/observed/media/forbidden-write','bad');throw Error('素材可写');} catch(e) {if(e.code !== 'EROFS') throw e;}",
      ],
    }),
  );
  assert.deepEqual(JSON.parse(identity.command!.stdout), { uid, gid });
  const client = createProductClient(started.observation!.address!, {
    signal: controller.signal,
  });
  const intake = await intakeDirectories(client, {
    displayName: "Compose 正式持久性",
    directories: ["/observed/media"],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: [],
    workflowTimeoutMs: 300_000,
  });
  assert.equal(intake.executionStatus, "completed");
  assert(intake.observedRootIds.length > 0);
  assert(intake.assetIds.length > 0, "正常刷新必须形成可核查的识别结果");
  const settingsBefore = await client.get("/settings");
  const executionBefore = await client.get(`/executions/${intake.executionId}`);
  const detailBefore = await client.get(`/catalogue/${intake.assetIds[0]!}`);
  assert.equal(executionBefore.status, 200);
  assert.equal(detailBefore.status, 200);
  // 原场景保留 revoked 来源状态；正式撤销空根版本，不配置凭据或请求外网。
  const revoked = await client.post("/settings/connections", {
    source: "tmdb",
    action: "revoke",
    expectedVersion: 0,
  });
  assert.equal(revoked.status, 200);
  const connectionsBefore = await client.get("/settings");
  await writeFile(
    path.join(artifacts, "product-before.json"),
    JSON.stringify(
      {
        intake,
        settingsBefore,
        executionBefore,
        detailBefore,
        connectionsBefore,
      },
      null,
      2,
    ),
  );
  const stopped = await stop(normal, true);
  await assertOwnersStopped(normal, web(stopped));
  await save(normal);
  success(await operate({ ...normal, action: "compose-down" }));
  const restarted = await up(normal);
  const reopened = createProductClient(restarted.observation!.address!, {
    signal: controller.signal,
  });
  const libraries = await reopened.libraries();
  assert(
    libraries.some(
      (library) =>
        library.id === intake.assetLibraryId &&
        intake.observedRootIds.every((id) =>
          library.observedRootIds.includes(id),
        ),
    ),
  );
  assert.deepEqual(
    await reopened.get(`/executions/${intake.executionId}`),
    executionBefore,
  );
  assert.deepEqual(
    await reopened.get(`/catalogue/${intake.assetIds[0]!}`),
    detailBefore,
  );
  const connectionsAfter = await reopened.get("/settings");
  assert.deepEqual(connectionsAfter, connectionsBefore);
  await writeFile(
    path.join(artifacts, "product-after.json"),
    JSON.stringify({ libraries, connectionsAfter }, null, 2),
  );
  await stop(normal, true);
  await remove(normal);
  for (const [name, identity] of [
    ["uid-zero", { uid: 0, gid }],
    ["gid-zero", { uid, gid: 0 }],
  ] as const) {
    const reference = await prepare(name, identity);
    const rejected = await operate({ ...reference, action: "compose-up" });
    assert.equal(rejected.status, "failed", JSON.stringify(rejected));
    assert.equal(rejected.observation?.serviceReady, false);
    assert.equal(
      rejected.observation?.objects.find((object) => object.role === "task")
        ?.exitCode,
      64,
    );
    assert(
      rejected.observation?.objects.every((object) => object.running !== true),
    );
    await stop(reference, false);
    await remove(reference);
  }
  const failed = await prepare("migration-failure");
  const prepared = success(await operate({ ...failed, action: "inspect" }));
  // 原部署反例：只破坏本次新建的空根，不修改迁移或运行参数。
  await mkdir(
    path.join(prepared.observation!.dataDirectory!, "catalogue.sqlite"),
  );
  const rejected = await operate({ ...failed, action: "compose-up" });
  assert.equal(rejected.status, "failed", JSON.stringify(rejected));
  assert.equal(rejected.observation?.serviceReady, false);
  const migration = rejected.observation?.objects.find(
    (object) => object.role === "task",
  );
  assert(migration?.exitCode !== undefined && migration.exitCode !== 0);
  assert(
    rejected.observation?.objects.every((object) => object.running !== true),
  );
  assert(rejected.failure?.message);
  await stop(failed, false);
  await save(failed);
  assert.equal(await digestDirectory(observed), materialsBefore);
} catch (error) {
  mainError =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error("Compose 部署失败", mainError);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  // 场景保存失败也不能阻断独立停止；失败数据及记录交给显式后续操作。
  for (const reference of environments) {
    try {
      const stopped = await operate({ ...reference, action: "stop" }, true);
      if (stopped.status !== "ok") cleanupErrors.push(JSON.stringify(stopped));
      if (stopped.observation?.dataPresent) await save(reference);
    } catch (error) {
      cleanupErrors.push(`${reference.environment}: ${String(error)}`);
    }
  }
  await saveOperations();
  if (saveErrors.length > 0 || cleanupErrors.length > 0) process.exitCode = 1;
}
