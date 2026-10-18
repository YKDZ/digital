import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  manageContainerEnvironment,
  type ContainerObject,
  type ContainerOperationResult,
  type ContainerReference,
  type ContainerRequest,
} from "@digital/environment/container";
import { createPublicApiClient } from "@digital/public-api";

type PreparedDeployment = {
  readonly workspacePath: string;
  readonly revision: string;
  readonly endpoint: string;
  readonly daemonId: string;
  readonly composeVersion: string;
  readonly standaloneImage: string;
  readonly runtimeImage: string;
  readonly images: readonly {
    readonly reference: string;
    readonly id: string;
    readonly version: string | null;
  }[];
};

type OwnedEnvironment = ContainerReference & {
  readonly mode: "standalone" | "compose";
};

type ProductState = {
  readonly assetLibraryId: string;
  readonly executionId: string;
  readonly assetIds: readonly string[];
};

const workspacePath = path.resolve(import.meta.dirname, "../../..");
const preparedPath = path.resolve(
  process.env.DIGITAL_DEPLOYMENT_ARTIFACTS ??
    process.env.DIGITAL_CI_EVIDENCE ??
    path.join(import.meta.dirname, "../.turbo/deployment"),
  "prepared.json",
);
const explicitStandaloneImage = process.env.DIGITAL_DEPLOYMENT_STANDALONE_IMAGE;
const explicitRuntimeImage = process.env.DIGITAL_DEPLOYMENT_RUNTIME_IMAGE;
if (
  (explicitStandaloneImage === undefined) !==
  (explicitRuntimeImage === undefined)
)
  throw new Error("显式部署需要同时提供独立准备与仅运行镜像");

const runId = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const artifacts = path.resolve(
  process.env.DIGITAL_DEPLOYMENT_ARTIFACTS ??
    process.env.DIGITAL_CI_EVIDENCE ??
    path.join(import.meta.dirname, `../.turbo/deployment/run-${runId}`),
);
const sourceMaterialRoot = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/material"),
);
const endpoint = {
  command: process.env.DIGITAL_DEPLOYMENT_DOCKER_COMMAND ?? "docker",
  arguments: JSON.parse(
    process.env.DIGITAL_DEPLOYMENT_DOCKER_ARGUMENTS ?? "[]",
  ) as string[],
  host: process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock",
};
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort(new Error(`收到 ${signal}`)));
const environments: OwnedEnvironment[] = [];
const operations: Array<{
  readonly request: ContainerRequest;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly result: ContainerOperationResult;
}> = [];
const saveErrors: string[] = [];
const stopErrors: string[] = [];
const cleanupErrors: string[] = [];
let mainError: string | undefined;
let prepared: PreparedDeployment | undefined;
let mediaRoot: string | undefined;

function currentDeployment(): PreparedDeployment {
  assert.ok(prepared, "服务部署镜像尚未解析");
  return prepared;
}

function requireSuccess(
  result: ContainerOperationResult,
): ContainerOperationResult {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result;
}

async function saveOperations(): Promise<void> {
  try {
    await writeFile(
      path.join(artifacts, "operations.json"),
      JSON.stringify(
        { operations, mainError, saveErrors, stopErrors, cleanupErrors },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch (error) {
    saveErrors.push(String(error));
    console.error("保存容器操作证据失败", error);
  }
}

async function operate(
  request: ContainerRequest,
  cleanup = false,
  signal: AbortSignal | undefined = controller.signal,
): Promise<ContainerOperationResult> {
  const startedAt = new Date().toISOString();
  const result = await manageContainerEnvironment(
    request,
    cleanup || signal === undefined ? {} : { signal },
  );
  const finishedAt = new Date().toISOString();
  operations.push({ request, startedAt, finishedAt, result });
  console.log(
    JSON.stringify({
      environment: request.environment,
      action: request.action,
      status: result.status,
      failure: result.failure,
      finishedAt,
    }),
  );
  if (result.saveErrors.length > 0) saveErrors.push(...result.saveErrors);
  if (result.cleanupErrors.length > 0)
    cleanupErrors.push(...result.cleanupErrors);
  await saveOperations();
  return result;
}

function newReference(
  label: string,
  mode: OwnedEnvironment["mode"],
): OwnedEnvironment {
  const reference: OwnedEnvironment = {
    workspacePath,
    environment: `ewc22-${runId}-${label}`,
    mode,
  };
  environments.push(reference);
  return reference;
}

async function registerOwner(reference: ContainerReference): Promise<void> {
  const directory = process.env.DIGITAL_CI_EVIDENCE;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(
    path.join(directory, "container-owners.ndjson"),
    `${JSON.stringify({ at: new Date().toISOString(), ...reference })}\n`,
    { mode: 0o600 },
  );
}

async function prepareStandalone(
  label: string,
  mounts: readonly {
    readonly source: string;
    readonly target: string;
    readonly readonly: true;
  }[],
): Promise<OwnedEnvironment> {
  const reference = newReference(label, "standalone");
  await registerOwner(reference);
  requireSuccess(
    await operate({
      ...reference,
      action: "prepare",
      endpoint,
      image: currentDeployment().standaloneImage,
      mounts,
    }),
  );
  return reference;
}

async function prepareCompose(
  label: string,
  observedPath: string,
  uid = Number(process.env.DIGITAL_COMPOSE_CHECK_UID ?? "1001"),
  gid = Number(process.env.DIGITAL_COMPOSE_CHECK_GID ?? "1001"),
): Promise<OwnedEnvironment> {
  const reference = newReference(label, "compose");
  await registerOwner(reference);
  const port =
    process.env.DIGITAL_COMPOSE_CHECK_PORT === undefined
      ? await claimFreePort()
      : Number(process.env.DIGITAL_COMPOSE_CHECK_PORT);
  requireSuccess(
    await operate({
      ...reference,
      action: "prepare-compose",
      endpoint,
      image: currentDeployment().standaloneImage,
      compose: {
        file: path.join(workspacePath, "docker-compose.yml"),
        configuration: {
          DIGITAL_SERVICE_MIGRATION_IMAGE: currentDeployment().standaloneImage,
          DIGITAL_SERVICE_RUNTIME_IMAGE: currentDeployment().runtimeImage,
          DIGITAL_UID: String(uid),
          DIGITAL_GID: String(gid),
          DIGITAL_OBSERVED_ROOT_HOST_PATH: observedPath,
          DIGITAL_BIND_ADDRESS: "127.0.0.1",
          DIGITAL_PORT: String(port),
        },
        services: [
          { name: "migrate", role: "task" },
          { name: "service", role: "service" },
        ],
        dataVariable: "DIGITAL_PRODUCT_DATA_HOST_PATH",
        dataOwner: { uid, gid },
      },
    }),
  );
  return reference;
}

function serviceObject(result: ContainerOperationResult): ContainerObject {
  const service = result.observation?.objects.findLast(
    (object) => object.role === "service" && object.state === "present",
  );
  assert.ok(service?.id, JSON.stringify(result));
  return service;
}

function taskObject(result: ContainerOperationResult): ContainerObject {
  const task = result.observation?.objects.findLast(
    (object) => object.role === "task" && object.state === "present",
  );
  assert.ok(task, JSON.stringify(result));
  return task;
}

async function startStandalone(
  reference: ContainerReference,
  image: string,
  waitFor: "ready" | "live" = "ready",
): Promise<ContainerOperationResult> {
  const port =
    process.env.DIGITAL_DEPLOYMENT_PORT === undefined
      ? await claimFreePort()
      : Number(process.env.DIGITAL_DEPLOYMENT_PORT);
  return requireSuccess(
    await operate({
      ...reference,
      action: "start",
      image,
      publish: { hostIp: "127.0.0.1", hostPort: port, containerPort: 3000 },
      waitFor,
    }),
  );
}

async function startCompose(
  reference: ContainerReference,
): Promise<ContainerOperationResult> {
  const result = requireSuccess(
    await operate({ ...reference, action: "compose-up" }),
  );
  const migration = taskObject(result);
  assert.equal(migration.running, false, JSON.stringify(migration));
  assert.equal(migration.exitCode, 0, JSON.stringify(migration));
  assert.equal(result.observation?.serviceReady, true, JSON.stringify(result));
  const service = serviceObject(result);
  assert.equal(service.running, true, JSON.stringify(service));
  requireSuccess(
    await operate({
      ...reference,
      action: "wait",
      objectId: service.id!,
      condition: "live",
    }),
  );
  requireSuccess(
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

async function verifyServiceAddress(address: string): Promise<void> {
  const live = await fetch(new URL("/api/live", address), {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(live.status, 200);
  assert.equal(((await live.json()) as { readonly ok: boolean }).ok, true);
  const ready = await fetch(new URL("/api/ready", address), {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(ready.status, 200);
  assert.equal(((await ready.json()) as { readonly ok: boolean }).ok, true);
  const client = createPublicApiClient({ baseUrl: address });
  await client.listAssetLibraries();
}

async function verifyRuntimeIdentity(
  reference: ContainerReference,
  service: ContainerObject,
  uid = 1001,
  gid = 1001,
): Promise<void> {
  const command = await operate({
    ...reference,
    action: "exec",
    objectId: service.id!,
    command: [
      "node",
      "--input-type=module",
      "--eval",
      "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()}));",
    ],
  });
  requireSuccess(command);
  const identity = JSON.parse(command.command?.stdout ?? "null") as {
    readonly uid: number;
    readonly gid: number;
  } | null;
  assert.deepEqual(identity, {
    uid,
    gid,
  });
}

async function verifyReadOnlyMaterials(
  reference: ContainerReference,
  service: ContainerObject,
  paths: readonly string[],
  uid: number,
  gid: number,
): Promise<void> {
  const encodedPaths = JSON.stringify(paths);
  const script = `import fs from 'node:fs'; const paths=${encodedPaths}; const uid=process.getuid(); const gid=process.getgid(); if(uid!==${uid}||gid!==${gid}) throw Error('服务身份不符合部署配置'); fs.writeFileSync('/data/.ewc22-write-check','ok'); fs.unlinkSync('/data/.ewc22-write-check'); const failures=[]; for(const root of paths){ try {fs.writeFileSync(root+'/.ewc22-forbidden-write','bad'); fs.unlinkSync(root+'/.ewc22-forbidden-write'); failures.push(root+':writable')} catch(error){ if(error.code!=='EROFS'&&error.code!=='EACCES') throw error; }} if(failures.length) throw Error('观察素材可写：'+failures.join(',')); console.log(JSON.stringify({uid,gid,dataWritable:true,materialsReadonly:paths}));`;
  requireSuccess(
    await operate({
      ...reference,
      action: "exec",
      objectId: service.id!,
      command: ["node", "--input-type=module", "--eval", script],
    }),
  );
}

async function scanProduct(
  address: string,
  displayName: string,
  directories: readonly string[],
): Promise<ProductState> {
  const client = createPublicApiClient({ baseUrl: address });
  const library = await client.saveAssetLibrary({
    displayName,
    directories: [...directories],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: [],
  });
  assert.deepEqual(
    library.directories.map(({ path: directory }) => directory).toSorted(),
    [...directories].toSorted(),
  );
  const started = await client.startAssetLibraryScan(library.id);
  const deadline = Date.now() + 300_000;
  let scan = await client.inspectAssetLibraryScan(started.parentExecutionId);
  while (scan.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    scan = await client.inspectAssetLibraryScan(started.parentExecutionId);
  }
  assert.equal(scan.status, "completed", JSON.stringify(scan));
  assert.equal(
    scan.directories.length,
    directories.length,
    JSON.stringify(scan),
  );
  assert(
    scan.directories.every((directory) => directory.stage === "settled"),
    JSON.stringify(scan.directories),
  );
  const scannedIds = new Set(
    scan.directories.flatMap((directory) =>
      directory.files.flatMap((file) =>
        file.assetId === undefined ? [] : [file.assetId],
      ),
    ),
  );
  assert(scannedIds.size > 0, "正式扫描应产生可核查的资产身份");

  const assets: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAssets({
      assetLibraryId: library.id,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    assets.push(...page.items.map(({ id }) => id));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  assert(assets.length > 0);
  assert(
    assets.some((assetId) => scannedIds.has(assetId)),
    "资产列表应读回本次正式目录扫描产生的资产",
  );

  const unrecognized = await client.listUnrecognizedMaterials({
    assetLibraryId: library.id,
    limit: 100,
  });
  assert(
    unrecognized.items.some((item) =>
      item.relativePaths.includes("普通文件夹/杂项/材料列表.txt"),
    ),
    "扫描结果应保留普通目录中的未识别说明材料",
  );

  const cancellation = await client.cancelExecution(started.parentExecutionId, {
    reason: "容器验收确认已结束的扫描保持原结局",
  });
  assert.equal(cancellation.requestStatus, "already-finished");
  assert.equal(cancellation.inspection.status, "completed");
  return {
    assetLibraryId: library.id,
    executionId: started.parentExecutionId,
    assetIds: assets.toSorted(),
  };
}

async function verifyPersistedProduct(
  address: string,
  displayName: string,
  state: ProductState,
): Promise<void> {
  const client = createPublicApiClient({ baseUrl: address });
  const libraries = await client.listAssetLibraries();
  assert(
    libraries.items.some(
      ({ id, displayName: currentName }) =>
        id === state.assetLibraryId && currentName === displayName,
    ),
  );
  const scan = await client.inspectAssetLibraryScan(state.executionId);
  assert.equal(scan.status, "completed");
  assert.equal(scan.assetLibraryId, state.assetLibraryId);
  const assets = await client.listAssets({
    assetLibraryId: state.assetLibraryId,
    limit: 100,
  });
  assert.deepEqual(assets.items.map(({ id }) => id).toSorted(), state.assetIds);
}

async function stopService(
  reference: ContainerReference,
  normal = true,
): Promise<ContainerOperationResult> {
  const result = requireSuccess(
    await operate({ ...reference, action: "stop" }, true),
  );
  assert(
    result.observation?.objects.every((object) => object.running !== true),
    JSON.stringify(result),
  );
  if (normal) {
    const service = serviceObject(result);
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

async function assertServiceTemporaryRootsClosed(
  reference: ContainerReference,
  service: ContainerObject,
): Promise<void> {
  const archive = path.join(artifacts, `${reference.environment}-stopped.tar`);
  requireSuccess(
    await operate(
      {
        ...reference,
        action: "export",
        objectId: service.id!,
        destination: archive,
      },
      true,
    ),
  );
  const result = await runCommand(
    "tar",
    [
      "--list",
      "--file",
      archive,
      "--wildcards",
      "--no-anchored",
      "tmp/digital-product-service-process-*",
    ],
    workspacePath,
  );
  assert.equal(result.stdout.trim(), "", "服务停止后不应保留进程临时根");
  assert(
    result.exitCode === 0 ||
      (result.exitCode === 2 && result.stderr.includes("Not found in archive")),
    JSON.stringify(result),
  );
}

async function saveEnvironment(
  reference: ContainerReference,
  suffix: string,
): Promise<boolean> {
  const result = await operate(
    {
      ...reference,
      action: "save",
      directory: path.join(
        artifacts,
        "saved",
        `${reference.environment}-${suffix}`,
      ),
      includeData: true,
    },
    true,
  );
  const saved = result.status === "ok" && result.evidence?.dataSaved === true;
  if (!saved)
    saveErrors.push(`${reference.environment}: ${JSON.stringify(result)}`);
  return saved;
}

async function buildObservedMaterial(): Promise<{
  readonly root: string;
  readonly directories: readonly string[];
  readonly digest: string;
}> {
  const visibleRoot = path.resolve(
    process.env.DIGITAL_COMPOSE_CHECK_ROOT ??
      path.join(import.meta.dirname, "../.turbo/deployment"),
  );
  const root = path.join(visibleRoot, `ewc22-${runId}-observed`);
  const first = path.join(root, "one");
  const second = path.join(root, "two");
  const inputs = [
    path.join(sourceMaterialRoot, "RJ01029383"),
    path.join(sourceMaterialRoot, "RJ01196709"),
  ];
  const inputDigest = await Promise.all(inputs.map(digestDirectory));
  await mkdir(path.join(first, "作者甲", "2024"), {
    recursive: true,
    mode: 0o755,
  });
  await mkdir(path.join(second, "作者乙", "2025", "已归档"), {
    recursive: true,
    mode: 0o755,
  });
  await Promise.all([
    cp(inputs[0]!, path.join(first, "作者甲", "2024", "RJ01029383"), {
      recursive: true,
    }),
    cp(
      inputs[1]!,
      path.join(second, "作者乙", "2025", "已归档", "RJ01196709"),
      {
        recursive: true,
      },
    ),
  ]);
  const notes = path.join(second, "普通文件夹", "杂项");
  await mkdir(notes, { recursive: true, mode: 0o755 });
  await writeFile(path.join(notes, "材料列表.txt"), "用户自己的说明\n");
  await chmod(root, 0o755);
  const directories = [first, second];
  assert.deepEqual(await Promise.all(inputs.map(digestDirectory)), inputDigest);
  return { root, directories, digest: await digestDirectory(root) };
}

async function verifyMaterialUnchanged(
  material: Awaited<ReturnType<typeof buildObservedMaterial>>,
): Promise<void> {
  assert.equal(await digestDirectory(material.root), material.digest);
}

async function verifyEmptyDefaultStart(
  material: Awaited<ReturnType<typeof buildObservedMaterial>>,
): Promise<void> {
  const mounts = [
    {
      source: path.join(material.root, "one"),
      target: "/observed/one",
      readonly: true as const,
    },
    {
      source: path.join(material.root, "two"),
      target: "/observed/two",
      readonly: true as const,
    },
  ];
  const reference = await prepareStandalone("combined", mounts);
  const running = await startStandalone(
    reference,
    currentDeployment().standaloneImage,
  );
  assert.equal(running.observation?.serviceReady, true);
  await verifyServiceAddress(running.observation!.address!);
  const service = serviceObject(running);
  await verifyRuntimeIdentity(reference, service);
  await stopService(reference);
  await assertServiceTemporaryRootsClosed(reference, service);
  await saveEnvironment(reference, "combined");
}

async function verifyPreparedStandalone(
  material: Awaited<ReturnType<typeof buildObservedMaterial>>,
): Promise<void> {
  const reference = await prepareStandalone("prepared", [
    {
      source: path.join(material.root, "one"),
      target: "/observed/one",
      readonly: true,
    },
    {
      source: path.join(material.root, "two"),
      target: "/observed/two",
      readonly: true,
    },
  ]);
  const preparedTask = requireSuccess(
    await operate({
      ...reference,
      action: "start",
      image: currentDeployment().standaloneImage,
      role: "task",
      command: ["prepare-only"],
      waitFor: "exit",
    }),
  );
  const task = taskObject(preparedTask);
  assert.equal(task.running, false);
  assert.equal(task.exitCode, 0);
  assert.equal(Object.keys(task.ports ?? {}).length, 0);

  const running = await startStandalone(
    reference,
    currentDeployment().runtimeImage,
  );
  assert.equal(running.observation?.serviceReady, true);
  await verifyServiceAddress(running.observation!.address!);
  const service = serviceObject(running);
  await verifyRuntimeIdentity(reference, service);
  await verifyReadOnlyMaterials(
    reference,
    service,
    ["/observed/one", "/observed/two"],
    1001,
    1001,
  );
  const displayName = "Standalone 多目录验收";
  const state = await scanProduct(running.observation!.address!, displayName, [
    "/observed/one",
    "/observed/two",
  ]);
  await verifyMaterialUnchanged(material);
  const stopped = await stopService(reference);
  await assertServiceTemporaryRootsClosed(reference, serviceObject(stopped));

  const restarted = await startStandalone(
    reference,
    currentDeployment().runtimeImage,
  );
  assert.equal(restarted.observation?.serviceReady, true);
  await verifyPersistedProduct(
    restarted.observation!.address!,
    displayName,
    state,
  );
  await verifyMaterialUnchanged(material);
  const finalStop = await stopService(reference);
  await assertServiceTemporaryRootsClosed(reference, serviceObject(finalStop));
  await saveEnvironment(reference, "persistent");
}

async function verifyStandaloneRejectsUnpreparedData(): Promise<void> {
  const reference = await prepareStandalone("unprepared", []);
  const result = await operate({
    ...reference,
    action: "start",
    image: currentDeployment().runtimeImage,
    publish: {
      hostIp: "127.0.0.1",
      hostPort:
        process.env.DIGITAL_DEPLOYMENT_PORT === undefined
          ? await claimFreePort()
          : Number(process.env.DIGITAL_DEPLOYMENT_PORT),
      containerPort: 3000,
    },
    waitFor: "live",
  });
  assert.notEqual(result.status, "cancelled", JSON.stringify(result));
  assert.equal(result.observation?.serviceReady, false, JSON.stringify(result));
  if (result.status === "ok") {
    const response = await fetch(
      new URL("/api/ready", result.observation!.address!),
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(response.status, 503);
  }
  const service = serviceObject(result);
  const cancellation = new AbortController();
  const cancellationTimer = setTimeout(
    () => cancellation.abort(new Error("验证未准备数据的就绪等待可取消")),
    500,
  );
  let cancelled: ContainerOperationResult;
  try {
    cancelled = await operate(
      {
        ...reference,
        action: "wait",
        objectId: service.id!,
        condition: "ready",
        timeoutMilliseconds: 120_000,
      },
      false,
      cancellation.signal,
    );
  } finally {
    clearTimeout(cancellationTimer);
  }
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  assert(
    cancelled.observation?.objects.every(
      (object) => object.running !== true && object.state !== "unknown",
    ),
    JSON.stringify(cancelled),
  );
  await stopService(reference, false);
  await saveEnvironment(reference, "unprepared");
}

async function verifyComposeProduct(
  material: Awaited<ReturnType<typeof buildObservedMaterial>>,
): Promise<void> {
  const uid = Number(process.env.DIGITAL_COMPOSE_CHECK_UID ?? "1001");
  const gid = Number(process.env.DIGITAL_COMPOSE_CHECK_GID ?? "1001");
  assert(uid > 0 && gid > 0, "Compose 服务必须使用非 root UID/GID");
  const reference = await prepareCompose(
    "compose-product",
    material.root,
    uid,
    gid,
  );
  const running = await startCompose(reference);
  await verifyServiceAddress(running.observation!.address!);
  const service = serviceObject(running);
  await verifyRuntimeIdentity(reference, service, uid, gid);
  await verifyReadOnlyMaterials(
    reference,
    service,
    ["/observed/media"],
    uid,
    gid,
  );
  const displayName = "Compose 多目录验收";
  const state = await scanProduct(running.observation!.address!, displayName, [
    "/observed/media/one",
    "/observed/media/two",
  ]);
  await verifyMaterialUnchanged(material);
  const stopped = await stopService(reference);
  await assertServiceTemporaryRootsClosed(reference, serviceObject(stopped));
  assert(
    await saveEnvironment(reference, "compose-stopped"),
    "Compose 首次关闭前必须保存完整证据与数据",
  );
  requireSuccess(await operate({ ...reference, action: "compose-down" }, true));

  const restarted = await startCompose(reference);
  await verifyPersistedProduct(
    restarted.observation!.address!,
    displayName,
    state,
  );
  await verifyMaterialUnchanged(material);
  const finalStop = await stopService(reference);
  await assertServiceTemporaryRootsClosed(reference, serviceObject(finalStop));
  assert(
    await saveEnvironment(reference, "persistent"),
    "Compose 持久化复验后关闭前必须保存完整证据与数据",
  );
  requireSuccess(await operate({ ...reference, action: "compose-down" }, true));
}

async function verifyComposeRejectsPreparationFailures(
  material: Awaited<ReturnType<typeof buildObservedMaterial>>,
): Promise<void> {
  const missingMount = path.join(material.root, `missing-${runId}`);
  const missing = await prepareCompose("compose-missing-mount", missingMount);
  const missingResult = await operate({ ...missing, action: "compose-up" });
  assert.notEqual(missingResult.status, "ok", JSON.stringify(missingResult));
  assert.equal(missingResult.observation?.serviceReady, false);
  assert(
    missingResult.observation?.objects.every(
      (object) => object.running !== true,
    ) ?? true,
  );
  await stopService(missing, false);
  await saveEnvironment(missing, "missing-mount");

  for (const [label, uid, gid] of [
    ["uid-zero", 0, 1001],
    ["gid-zero", 1001, 0],
  ] as const) {
    const reference = await prepareCompose(label, material.root, uid, gid);
    const result = await operate({ ...reference, action: "compose-up" });
    assert.notEqual(result.status, "ok", JSON.stringify(result));
    assert.equal(result.observation?.serviceReady, false);
    assert(
      result.observation?.objects.every((object) => object.running !== true) ??
        true,
    );
    await stopService(reference, false);
    await saveEnvironment(reference, label);
  }

  const broken = await prepareCompose(
    "compose-migration-failure",
    material.root,
  );
  const before = requireSuccess(
    await operate({ ...broken, action: "inspect" }, true),
  );
  const dataDirectory = before.observation?.dataDirectory;
  assert(dataDirectory);
  await mkdir(path.join(dataDirectory, "catalogue.sqlite"));
  const failedMigration = await operate({ ...broken, action: "compose-up" });
  assert.notEqual(
    failedMigration.status,
    "ok",
    JSON.stringify(failedMigration),
  );
  assert.equal(failedMigration.observation?.serviceReady, false);
  assert(
    failedMigration.observation?.objects.every(
      (object) => object.running !== true,
    ) ?? true,
  );
  assert(failedMigration.failure?.message);
  await stopService(broken, false);
  await saveEnvironment(broken, "migration-failure");
  await verifyMaterialUnchanged(material);
}

async function verifyStandalonePreparationFailure(
  material: Awaited<ReturnType<typeof buildObservedMaterial>>,
): Promise<void> {
  const reference = await prepareStandalone("migration-failure", [
    {
      source: path.join(material.root, "one"),
      target: "/observed/one",
      readonly: true,
    },
    {
      source: path.join(material.root, "two"),
      target: "/observed/two",
      readonly: true,
    },
  ]);
  const seed = requireSuccess(
    await operate({
      ...reference,
      action: "start",
      role: "client",
      image: currentDeployment().standaloneImage,
      entrypoint: "node",
      command: [
        "--input-type=module",
        "--eval",
        "import fs from 'node:fs'; fs.mkdirSync('/data/catalogue.sqlite')",
      ],
      useData: true,
      waitFor: "exit",
    }),
  );
  const seededVolume = seed.observation?.objects.findLast(
    (object) => object.role === "client" && object.state === "present",
  );
  assert.equal(seededVolume?.usesData, true, JSON.stringify(seed));
  assert.equal(seededVolume?.running, false, JSON.stringify(seed));
  assert.equal(seededVolume?.exitCode, 0, JSON.stringify(seed));
  const failedMigration = requireSuccess(
    await operate({
      ...reference,
      action: "start",
      image: currentDeployment().standaloneImage,
      role: "task",
      command: ["prepare-only"],
      waitFor: "exit",
    }),
  );
  const failedTask = taskObject(failedMigration);
  assert.equal(failedTask.running, false, JSON.stringify(failedTask));
  assert.notEqual(failedTask.exitCode, undefined, JSON.stringify(failedTask));
  assert.notEqual(failedTask.exitCode, 0, JSON.stringify(failedTask));
  await stopService(reference, false);
  await saveEnvironment(reference, "migration-failure");
  await verifyMaterialUnchanged(material);
}

async function cleanupOwnedEnvironments(): Promise<void> {
  for (const reference of environments) {
    try {
      const stopped = await operate({ ...reference, action: "stop" }, true);
      if (stopped.status !== "ok")
        stopErrors.push(
          `${reference.environment}: ${stopped.failure?.message ?? stopped.status}`,
        );
    } catch (error) {
      stopErrors.push(`${reference.environment}: ${String(error)}`);
    }
  }

  for (const reference of environments) {
    try {
      const observed = requireSuccess(
        await operate({ ...reference, action: "inspect" }, true),
      );
      if (observed.remaining.length === 0 && !observed.observation?.dataPresent)
        continue;

      if (
        observed.observation?.objects.some(
          (object) => object.running === true || object.state === "unknown",
        )
      ) {
        cleanupErrors.push(
          `${reference.environment}: 退出状态未确认，保留载体`,
        );
        continue;
      }
      const includeData =
        observed.observation?.dataPresent === true ||
        observed.remaining.some(
          (object) => object.kind === "volume" && object.state === "present",
        );
      const saved = await operate(
        {
          ...reference,
          action: "save",
          directory: path.join(
            artifacts,
            "saved",
            `${reference.environment}-final`,
          ),
          includeData,
        },
        true,
      );
      if (
        saved.status !== "ok" ||
        (includeData && saved.evidence?.dataSaved !== true)
      ) {
        saveErrors.push(
          `${reference.environment}: 失败证据或产品数据未完整保存，保留载体`,
        );
        continue;
      }
      if (process.env.DIGITAL_CI_EVIDENCE !== undefined) continue;

      const deleted = await operate(
        { ...reference, action: "delete", deleteData: includeData },
        true,
      );
      if (
        deleted.status !== "ok" ||
        deleted.remaining.length > 0 ||
        deleted.observation?.dataPresent
      )
        cleanupErrors.push(`${reference.environment}: 自有资源回收未完成`);
      const after = await operate({ ...reference, action: "inspect" }, true);
      if (
        after.status !== "ok" ||
        after.remaining.length > 0 ||
        after.observation?.dataPresent
      )
        cleanupErrors.push(`${reference.environment}: 删除后公开观察仍有资源`);
    } catch (error) {
      cleanupErrors.push(`${reference.environment}: ${String(error)}`);
    }
  }
}

async function resolvePreparedDeployment(): Promise<PreparedDeployment> {
  if (
    explicitStandaloneImage !== undefined &&
    explicitRuntimeImage !== undefined
  ) {
    return {
      workspacePath,
      revision: "caller-supplied",
      endpoint: endpoint.host,
      daemonId: "caller-supplied",
      composeVersion: "caller-supplied",
      standaloneImage: explicitStandaloneImage,
      runtimeImage: explicitRuntimeImage,
      images: [],
    };
  }
  let value: PreparedDeployment;
  try {
    value = JSON.parse(
      await readFile(preparedPath, "utf8"),
    ) as PreparedDeployment;
  } catch (cause) {
    throw new Error("服务镜像尚未准备；请运行正式 deployment Turbo 任务", {
      cause,
    });
  }
  if (
    value.workspacePath !== workspacePath ||
    !value.standaloneImage ||
    !value.runtimeImage
  )
    throw new Error("准备镜像与当前工作区不一致");
  return value;
}

async function digestDirectory(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .toSorted();
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(path.relative(root, file));
    digest.update(await readFile(file));
  }
  return digest.digest("hex");
}

async function claimFreePort(): Promise<number> {
  const first = 56_000;
  const last = 56_999;
  for (let port = first; port <= last; port += 1) {
    const claimed = await probePort(port);
    if (claimed !== undefined) return claimed;
  }
  throw new Error(`自有端口段 ${first}—${last} 内没有空闲端口`);
}

function probePort(port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(undefined));
    server.once("listening", () => {
      const address = server.address();
      server.close(() => {
        resolve(
          typeof address === "object" && address !== null
            ? address.port
            : undefined,
        );
      });
    });
    server.listen(port, "127.0.0.1");
  });
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
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
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function main(): Promise<void> {
  prepared = await resolvePreparedDeployment();
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const material = await buildObservedMaterial();
  mediaRoot = material.root;
  const originalDigest = await digestDirectory(sourceMaterialRoot);
  const port = process.env.DIGITAL_DEPLOYMENT_PORT;
  if (
    port !== undefined &&
    (!Number.isSafeInteger(Number(port)) || Number(port) < 1)
  )
    throw new Error("Standalone 部署端口无效");
  await verifyEmptyDefaultStart(material);
  await verifyStandaloneRejectsUnpreparedData();
  await verifyPreparedStandalone(material);
  await verifyStandalonePreparationFailure(material);
  await verifyComposeProduct(material);
  await verifyComposeRejectsPreparationFailures(material);
  await verifyMaterialUnchanged(material);
  assert.equal(await digestDirectory(sourceMaterialRoot), originalDigest);
}

try {
  await main();
} catch (error) {
  mainError =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error("独立服务容器验收失败", mainError);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  await cleanupOwnedEnvironments();
  const outcomePath = path.join(artifacts, "outcome.json");
  try {
    await writeFile(
      outcomePath,
      JSON.stringify(
        {
          status:
            mainError === undefined &&
            stopErrors.length === 0 &&
            saveErrors.length === 0 &&
            cleanupErrors.length === 0
              ? "passed"
              : "failed",
          runId,
          revision: prepared?.revision ?? null,
          daemonId: prepared?.daemonId ?? null,
          composeVersion: prepared?.composeVersion ?? null,
          images: prepared?.images ?? [],
          standaloneImage: prepared?.standaloneImage ?? null,
          runtimeImage: prepared?.runtimeImage ?? null,
          preparedPath,
          mediaRoot: mediaRoot ?? null,
          mainError: mainError ?? null,
          stopErrors,
          saveErrors,
          cleanupErrors,
          environments,
          operationsPath: path.join(artifacts, "operations.json"),
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch (error) {
    saveErrors.push(String(error));
    console.error("保存容器验收结果失败", error);
  }
  if (
    mainError !== undefined ||
    stopErrors.length > 0 ||
    saveErrors.length > 0 ||
    cleanupErrors.length > 0
  )
    process.exitCode = 1;
  else if (
    process.env.DIGITAL_CI_EVIDENCE === undefined &&
    mediaRoot !== undefined
  )
    await rm(mediaRoot, { recursive: true, force: true });
}
