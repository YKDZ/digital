import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chown,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  ContainerEndpoint,
  ComposeDeployment,
  ContainerMount,
  ContainerObject,
  ContainerObservation,
  ContainerOperationResult,
  ContainerRequest,
} from "../container-environment.ts";
import type { OperationCancellation } from "./cancellation.ts";
import { createLayout } from "./paths.ts";
import {
  filteredEnvironment,
  HeldCommands,
  runLoggedCommand,
  type CommandRun,
} from "./processes.ts";
import { createDiagnosticRedactor } from "./redact.ts";

type ManagedObject = {
  -readonly [K in keyof ContainerObject]: ContainerObject[K];
};
type ContainerRecord = {
  schemaVersion: 1;
  workspacePath: string;
  environment: string;
  environmentId: string;
  managerId: string;
  runId: string;
  endpoint: ContainerEndpoint;
  daemonId: string;
  image: string;
  imageId: string;
  mounts: readonly ContainerMount[];
  configuration: Readonly<Record<string, string>>;
  objects: ManagedObject[];
  generation: number;
  serviceId?: string;
  address?: string;
  hasFailure: boolean;
  compose?: {
    project: string;
    file: string;
    fileDigest: string;
    overrideFile: string;
    deployment: ComposeDeployment;
    dataPresent: boolean;
    dataDevice: number;
    dataInode: number;
  };
  evidence?: { directory: string; generation: number; dataSaved: boolean };
};
type InspectedObject = {
  Id?: string;
  Name?: string;
  RepoTags?: string[];
  CreatedAt?: string;
  Created?: string;
  Labels?: Record<string, string>;
  Config?: { Labels?: Record<string, string>; User?: string };
  Image?: string;
  State?: {
    Running: boolean;
    Pid: number;
    ExitCode: number;
    OOMKilled: boolean;
    Health?: { Status: string };
  };
  NetworkSettings?: { Ports: ContainerObject["ports"] };
};
const labelRoot = "io.digital.environment";
const redact = createDiagnosticRedactor([]);

/** 容器机制只接触部署对象；产品资料、迁移设置及业务断言均由调用方持有。 */
export async function runContainerOperation(
  request: ContainerRequest,
  cancellation: OperationCancellation,
): Promise<ContainerOperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  if ("reason" in layout)
    return {
      operation: request.action,
      status: "failed",
      failure: { stage: "request", message: layout.reason },
      saveErrors: [],
      cleanupErrors: [],
      logs: [],
      remaining: [],
    };
  const recordPath = path.join(
    layout.containerDirectory,
    "container-record.json",
  );
  const operationId = randomUUID();
  const logs: string[] = [];
  const saveErrors: string[] = [];
  const cleanupErrors: string[] = [];
  let record: ContainerRecord | undefined;
  let failure: ContainerOperationResult["failure"];
  let commandResult: ContainerOperationResult["command"];
  let observation: ContainerObservation | undefined;
  let evidence: ContainerOperationResult["evidence"];
  let stage = "record";
  let sequence = 0;
  let observationUnknown = false;
  let cleanupAttempted = false;
  const stopsOnFailure = [
    "prepare",
    "prepare-compose",
    "compose-up",
    "build",
    "start",
    "wait",
    "save",
  ].includes(request.action);
  const held = new HeldCommands();
  const offCancel = cancellation.onTrigger(() => {
    void held.close();
  });

  const persist = async (): Promise<void> => {
    if (record === undefined) return;
    const temporary = `${recordPath}.${operationId}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), {
      mode: 0o600,
    });
    await rename(temporary, recordPath);
  };
  const labels = (object?: ManagedObject): Record<string, string> => {
    if (record === undefined) throw new Error("环境记录不可用");
    return {
      [`${labelRoot}.manager`]: record.managerId,
      [`${labelRoot}.environment`]: record.environmentId,
      [`${labelRoot}.run`]: record.runId,
      ...(object === undefined ? {} : { [`${labelRoot}.object`]: object.key }),
    };
  };
  const labelArgs = (object: ManagedObject): string[] =>
    Object.entries(labels(object)).flatMap(([key, value]) => [
      "--label",
      `${key}=${value}`,
    ]);
  const docker = async (
    args: readonly string[],
    cleanup = false,
    timeoutMilliseconds = 30_000,
    environment: Readonly<Record<string, string>> = {},
  ): Promise<CommandRun> => {
    if (record === undefined) throw new Error("环境端点尚未登记");
    if (!cleanup && cancellation.triggered())
      throw new Error(cancellation.reason());
    const file = path.join(
      layout.logsRoot,
      `${operationId}-${String(++sequence).padStart(3, "0")}.log`,
    );
    const run = async (logFile: string): Promise<CommandRun> =>
      await runLoggedCommand({
        command: record!.endpoint.command,
        args: [
          ...(record!.endpoint.arguments ?? []),
          "--host",
          record!.endpoint.host,
          ...args,
        ],
        cwd: layout.workspacePath,
        env: filteredEnvironment(process.env, environment),
        logFile,
        captureStdout: true,
        captureStderr: true,
        secretValues: [],
        held,
        ...(!cleanup
          ? {
              abortBeforeSpawn: () =>
                cancellation.triggered() ? cancellation.reason() : undefined,
            }
          : {}),
      });
    let result: CommandRun;
    try {
      const timer = setTimeout(() => {
        void held.close();
      }, timeoutMilliseconds);
      try {
        result = await run(file);
      } finally {
        clearTimeout(timer);
      }
      logs.push(file);
    } catch (error) {
      saveErrors.push(`命令日志无法取得：${redact(String(error))}`);
      if (!cleanup) throw error;
      // 保存介质失败仍必须停止：沿同一执行器收尾，明确承认此命令无法持久留证。
      result = await run("/dev/null");
    }
    if (result.logFailure !== undefined)
      saveErrors.push(result.logFailure.cause, ...result.logFailure.problems);
    if (result.stdoutOverflowed)
      throw new Error("Docker结构化输出超出可解析上限；完整日志另存，观察未知");
    return result;
  };
  const output = (result: CommandRun): string => {
    if (
      result.exitCode !== 0 ||
      result.spawnError !== undefined ||
      result.neverStarted !== undefined
    )
      throw new Error(
        redact(
          result.stderr?.trim() ||
            result.spawnError ||
            result.neverStarted ||
            `Docker命令失败：exit=${String(result.exitCode)} signal=${String(result.signal)}`,
        ),
      );
    return result.stdout?.trim() ?? "";
  };
  const markUnknown = (objects: ManagedObject[]): void => {
    for (const object of objects)
      if (object.state !== "absent") {
        object.state = "unknown";
        delete object.running;
        delete object.pid;
        delete object.exitCode;
        delete object.oomKilled;
        delete object.health;
        delete object.ports;
      }
  };
  const verifyDaemon = async (cleanup = false): Promise<void> => {
    try {
      const id = output(await docker(["info", "--format", "{{.ID}}"], cleanup));
      if (id !== record?.daemonId)
        throw new Error("Docker端点身份与登记不符，拒绝操作");
    } catch (error) {
      // 端点观察失败后，旧记录中的运行状态不能冒充本次实际观察。
      observationUnknown = true;
      markUnknown(record?.objects ?? []);
      throw error;
    }
  };
  const verify = async (
    object: ManagedObject,
    cleanup = false,
  ): Promise<InspectedObject | undefined> => {
    await verifyDaemon(cleanup);
    try {
      const result = await docker(
        [
          object.kind,
          "inspect",
          object.kind === "image" ? object.name : (object.id ?? object.name),
        ],
        cleanup,
      );
      if (result.exitCode !== 0) {
        const diagnostic = result.stderr?.trim() ?? "";
        if (
          /^(?:Error(?: response from daemon)?: )?No such (?:container|volume|network|object|image): /iu.test(
            diagnostic,
          ) ||
          (object.kind === "network" &&
            diagnostic ===
              `Error response from daemon: network ${object.id ?? object.name} not found`)
        ) {
          object.state = "absent";
          object.running = false;
          return undefined;
        }
        object.state = "unknown";
        throw new Error(
          redact(diagnostic || "Docker对象观察失败，不能判为不存在"),
        );
      }
      const inspected = (JSON.parse(output(result)) as InspectedObject[])[0];
      if (inspected === undefined)
        throw new Error("Docker inspect没有返回对象");
      const actualLabels = inspected.Labels ?? inspected.Config?.Labels ?? {};
      if (
        Object.entries(labels(object)).some(
          ([key, value]) => actualLabels[key] !== value,
        ) ||
        (object.kind === "image"
          ? !inspected.RepoTags?.includes(object.name)
          : (inspected.Name ?? "").replace(/^\//u, "") !== object.name) ||
        (object.id !== undefined && inspected.Id !== object.id) ||
        ((object.composeService !== undefined ||
          object.composeNetwork !== undefined) &&
          record?.compose !== undefined &&
          (actualLabels["com.docker.compose.project"] !==
            record.compose.project ||
            (object.composeService !== undefined &&
              actualLabels["com.docker.compose.service"] !==
                object.composeService) ||
            (object.composeNetwork !== undefined &&
              actualLabels["com.docker.compose.network"] !==
                object.composeNetwork)))
      ) {
        object.state = "unknown";
        throw new Error(
          `对象身份或归属不符：${object.kind}/${object.id ?? object.name}`,
        );
      }
      const createdAt = inspected.CreatedAt ?? inspected.Created;
      // Docker 20 的 local 卷 CreatedAt 来自可随写入变化的目录 ctime；
      // 卷归属按同一 daemon、预登记名称及完整随机标签核验，不把时间戳当不可变 ID。
      object.state = "present";
      if (object.kind !== "volume") {
        if (inspected.Id === undefined)
          throw new Error("Docker 对象缺少实际 ID");
        object.id = inspected.Id;
      }
      if (createdAt !== undefined) object.createdAt = createdAt;
      if (inspected.Image !== undefined) object.image = inspected.Image;
      if (inspected.State !== undefined) {
        object.running = inspected.State.Running;
        object.pid = inspected.State.Pid;
        object.exitCode = inspected.State.ExitCode;
        object.oomKilled = inspected.State.OOMKilled;
        if (inspected.State.Health?.Status === undefined) delete object.health;
        else object.health = inspected.State.Health.Status;
      }
      if (inspected.NetworkSettings?.Ports !== undefined)
        object.ports = inspected.NetworkSettings.Ports;
      return inspected;
    } catch (error) {
      markUnknown([object]);
      throw error;
    }
  };
  const reconcile = async (cleanup = false): Promise<void> => {
    if (record === undefined) return;
    await verifyDaemon(cleanup);
    for (const kind of ["container", "volume", "network", "image"] as const) {
      try {
        const args = [
          kind,
          "ls",
          ...(kind === "container" ? ["--all"] : []),
          ...(kind === "image" ? ["--no-trunc"] : []),
          "--quiet",
          ...Object.entries(labels()).flatMap(([key, value]) => [
            "--filter",
            `label=${key}=${value}`,
          ]),
        ];
        const identifiers = output(await docker(args, cleanup))
          .split("\n")
          .filter(Boolean);
        for (const identifier of identifiers) {
          const raw = (
            JSON.parse(
              output(await docker([kind, "inspect", identifier], cleanup)),
            ) as InspectedObject[]
          )[0];
          const key = (raw?.Labels ?? raw?.Config?.Labels)?.[
            `${labelRoot}.object`
          ];
          const object = record.objects.find(
            (candidate) => candidate.kind === kind && candidate.key === key,
          );
          if (object === undefined)
            throw new Error("发现本次标签下未预登记的对象，归属未知");
          if (object.id === undefined && kind !== "volume") {
            if (raw?.Id === undefined)
              throw new Error("Docker 对象缺少实际 ID");
            object.id = raw.Id;
            if (
              object.composeService !== undefined ||
              object.composeNetwork !== undefined
            )
              object.name = (raw.Name ?? "").replace(/^\//u, "");
          }
          await verify(object, cleanup);
        }
        for (const object of record.objects.filter(
          (candidate) => candidate.kind === kind,
        )) {
          if (
            object.state === "intent" &&
            !identifiers.some(
              (identifier) =>
                identifier === object.id || identifier === object.name,
            )
          )
            object.state = "absent";
          else if (object.state !== "absent") await verify(object, cleanup);
        }
      } catch (error) {
        observationUnknown = true;
        markUnknown(record.objects.filter((object) => object.kind === kind));
        throw error;
      }
    }
  };
  const add = async (
    kind: ManagedObject["kind"],
    role?: ManagedObject["role"],
  ): Promise<ManagedObject> => {
    if (record === undefined) throw new Error("环境尚未准备");
    const key = randomUUID();
    const object: ManagedObject = {
      kind,
      key,
      name: `${request.environment.slice(0, 24)}-${record.runId.slice(0, 8)}-${kind === "container" ? `${role ?? "service"}-${key.slice(0, 8)}` : kind === "image" ? `image-${key}` : kind}${kind === "image" ? ":latest" : ""}`,
      state: "intent",
      ...(role === undefined ? {} : { role }),
    };
    record.objects.push(object);
    record.generation += 1;
    // 创建意图及随机标签先于任何Docker副作用。
    await persist();
    return object;
  };
  const collectLogs = async (cleanup = false): Promise<void> => {
    for (const object of record?.objects.filter(
      (candidate) =>
        candidate.kind === "container" && candidate.state === "present",
    ) ?? []) {
      try {
        if (await verify(object, cleanup))
          output(await docker(["container", "logs", object.id!], cleanup));
      } catch (error) {
        saveErrors.push(`容器日志保存失败：${redact(String(error))}`);
      }
    }
  };
  const stop = async (): Promise<void> => {
    let stoppedRunningObject = false;
    await collectLogs(true);
    for (const object of record?.objects.filter(
      (candidate) => candidate.kind === "container",
    ) ?? []) {
      try {
        if (object.state === "absent") continue;
        if ((await verify(object, true)) && object.running) {
          stoppedRunningObject = true;
          const stopStarted = performance.now();
          output(
            await docker(
              ["container", "stop", "--time", "10", object.id!],
              true,
            ),
          );
          object.stopDurationMilliseconds = performance.now() - stopStarted;
          await verify(object, true);
          if (object.running) throw new Error("Docker stop后仍运行");
        }
      } catch (error) {
        cleanupErrors.push(
          `停止未确认：${object.id ?? object.name} ${redact(String(error))}`,
        );
      }
    }
    await collectLogs(true);
    if (record !== undefined && stoppedRunningObject) record.generation += 1;
  };
  const observe = async (): Promise<ContainerObservation | undefined> => {
    if (record === undefined) return undefined;
    let serviceReady = false;
    const service = record.objects.find(
      (object) => object.id === record?.serviceId && object.state === "present",
    );
    if (service?.running && record.address !== undefined)
      try {
        const response = await fetch(new URL("/api/ready", record.address), {
          redirect: "error",
          signal: AbortSignal.timeout(2_000),
        });
        const body = (await response.json()) as {
          ok?: unknown;
          service?: unknown;
        };
        serviceReady =
          response.status === 200 &&
          body.ok === true &&
          body.service === "digital-web";
      } catch {
        /* 当前产品未就绪与Docker观察失败分别表达。 */
      }
    const dataVolume = record.objects.find(
      (object) => object.kind === "volume",
    )?.name;
    return {
      environmentId: record.environmentId,
      managerId: record.managerId,
      runId: record.runId,
      daemonId: record.daemonId,
      ...(record.address === undefined ? {} : { address: record.address }),
      serviceReady,
      objects: structuredClone(record.objects),
      ...(dataVolume === undefined ? {} : { dataVolume }),
      ...(record.compose === undefined
        ? {}
        : {
            composeProject: record.compose.project,
            dataDirectory: layout.productDataRoot,
            dataPresent: record.compose.dataPresent,
          }),
      recordPath,
    };
  };
  const wait = async (
    object: ManagedObject,
    condition: "ready" | "live" | "exit" | "running" | "healthy",
    timeout: number,
  ): Promise<void> => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (cancellation.triggered()) throw new Error(cancellation.reason());
      if ((await verify(object)) === undefined)
        throw new Error("等待的自有容器已不存在");
      if (condition === "exit" && object.running === false) return;
      if (condition === "running" && object.running) return;
      if (
        condition === "healthy" &&
        object.running &&
        object.health === "healthy"
      )
        return;
      if (!object.running)
        throw new Error(
          `容器在${condition}之前退出：exit=${String(object.exitCode)}`,
        );
      if (
        (condition === "ready" || condition === "live") &&
        record?.address !== undefined
      )
        try {
          const response = await fetch(
            new URL(
              condition === "ready" ? "/api/ready" : "/api/live",
              record.address,
            ),
            { redirect: "error", signal: AbortSignal.timeout(2_000) },
          );
          const body = (await response.json()) as {
            ok?: unknown;
            service?: unknown;
          };
          if (
            response.status === 200 &&
            body.ok === true &&
            body.service === "digital-web"
          )
            return;
        } catch {
          /* 单次连接未就绪仍由原期限及对象身份约束。 */
        }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`容器未在${String(timeout)}毫秒内达到${condition}`);
  };

  const requireSaved = (data = false): void => {
    if (
      record?.evidence === undefined ||
      record.evidence.generation !== record.generation ||
      !existsSync(path.join(record.evidence.directory, "deployment.json"))
    )
      throw new Error("完整诊断尚未保存，禁止删除载体");
    if (data && record.hasFailure && !record.evidence.dataSaved)
      throw new Error("失败产品数据尚未保存，禁止删除");
  };
  const verifyDataDirectory = async (): Promise<void> => {
    if (record?.compose === undefined || !record.compose.dataPresent)
      throw new Error("自有产品数据目录不存在");
    const actual = await lstat(layout.productDataRoot);
    if (
      !actual.isDirectory() ||
      actual.dev !== record.compose.dataDevice ||
      actual.ino !== record.compose.dataInode
    )
      throw new Error("自有产品数据目录身份不符");
  };
  const compose = async (
    args: string[],
    timeout = 30_000,
  ): Promise<CommandRun> => {
    if (record?.compose === undefined) throw new Error("环境不是 Compose 部署");
    const deployment = record.compose;
    if (
      createHash("sha256")
        .update(await readFile(deployment.file))
        .digest("hex") !== deployment.fileDigest
    )
      throw new Error("Compose 配置快照已改变");
    return await docker(
      [
        "compose",
        "--project-name",
        deployment.project,
        "--env-file",
        "/dev/null",
        "--file",
        deployment.file,
        "--file",
        deployment.overrideFile,
        ...args,
      ],
      false,
      timeout,
      {
        ...deployment.deployment.configuration,
        [deployment.deployment.dataVariable]: layout.productDataRoot,
      },
    );
  };
  const verifyProject = async (): Promise<void> => {
    if (record?.compose === undefined) throw new Error("环境不是 Compose 部署");
    await verifyDaemon();
    for (const kind of ["container", "network"] as const) {
      const identifiers = output(
        await docker([
          kind,
          "ls",
          ...(kind === "container" ? ["--all"] : []),
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${record.compose.project}`,
        ]),
      )
        .split("\n")
        .filter(Boolean);
      for (const identifier of identifiers) {
        const raw = (
          JSON.parse(
            output(await docker([kind, "inspect", identifier])),
          ) as InspectedObject[]
        )[0];
        const actual = raw?.Labels ?? raw?.Config?.Labels ?? {};
        const object = record.objects.find(
          (candidate) =>
            candidate.kind === kind &&
            candidate.key === actual[`${labelRoot}.object`],
        );
        if (
          object === undefined ||
          Object.entries(labels(object)).some(
            ([key, value]) => actual[key] !== value,
          )
        )
          throw new Error("Compose 项目存在未授权对象，拒绝扩大操作范围");
        await verify(object);
      }
    }
  };

  try {
    await mkdir(layout.containerDirectory, { recursive: true, mode: 0o700 });
    if (request.action === "prepare" || request.action === "prepare-compose") {
      if (existsSync(recordPath) || existsSync(layout.recordPath))
        throw new Error("环境名已有记录；禁止按名字接管");
      if (!request.endpoint.host.startsWith("unix://"))
        throw new Error(
          "此本地容器能力要求显式daemon unix端点；远端访问由既有部署调用方提供",
        );
      const configuration =
        request.action === "prepare-compose"
          ? request.compose.configuration
          : (request.configuration ?? {});
      if (
        Object.keys(configuration).some((key) =>
          /secret|token|password|credential|cookie|api.?key/iu.test(key),
        )
      )
        throw new Error("秘密配置不能写入环境记录");
      record = {
        schemaVersion: 1,
        workspacePath: layout.workspacePath,
        environment: request.environment,
        environmentId: randomUUID(),
        managerId: randomUUID(),
        runId: randomUUID(),
        endpoint: request.endpoint,
        daemonId: "",
        image: request.image,
        imageId: "",
        mounts: request.action === "prepare" ? (request.mounts ?? []) : [],
        configuration,
        objects: [],
        generation: 0,
        hasFailure: false,
      };
      await persist();
      stage = "endpoint";
      record.daemonId = output(await docker(["info", "--format", "{{.ID}}"]));
      record.imageId = output(
        await docker([
          "image",
          "inspect",
          request.image,
          "--format",
          "{{.Id}}",
        ]),
      );
      await persist();
      if (request.action === "prepare-compose") {
        stage = "prepare-compose";
        const deployment = request.compose;
        if (
          deployment.services.filter((service) => service.role === "service")
            .length !== 1 ||
          deployment.services.some(
            (service) => !/^[a-zA-Z0-9_-]+$/u.test(service.name),
          ) ||
          new Set(deployment.services.map((service) => service.name)).size !==
            deployment.services.length
        )
          throw new Error("Compose 需要一个运行服务及明确的唯一服务名");
        if (
          !Number.isInteger(deployment.dataOwner.uid) ||
          !Number.isInteger(deployment.dataOwner.gid) ||
          deployment.dataOwner.uid < 0 ||
          deployment.dataOwner.gid < 0
        )
          throw new Error("数据目录身份无效");
        const bytes = await readFile(deployment.file);
        const file = path.join(
          layout.containerDirectory,
          "compose.json-or-yaml",
        );
        await writeFile(file, bytes, { mode: 0o600 });
        await mkdir(layout.productDataRoot, { mode: 0o700 });
        await chown(
          layout.productDataRoot,
          deployment.dataOwner.uid,
          deployment.dataOwner.gid,
        );
        const dataIdentity = await lstat(layout.productDataRoot);
        record.compose = {
          project: `digital-${record.runId}`,
          file,
          fileDigest: createHash("sha256").update(bytes).digest("hex"),
          overrideFile: path.join(
            layout.containerDirectory,
            "compose-owned.json",
          ),
          deployment,
          dataPresent: true,
          dataDevice: dataIdentity.dev,
          dataInode: dataIdentity.ino,
        };
        await persist();
      } else {
        stage = "create-volume";
        const volume = await add("volume");
        output(
          await docker(["volume", "create", ...labelArgs(volume), volume.name]),
        );
        await verify(volume);
        await persist();
        stage = "create-network";
        const network = await add("network");
        output(
          await docker([
            "network",
            "create",
            ...labelArgs(network),
            network.name,
          ]),
        );
        await verify(network);
      }
    } else {
      record = JSON.parse(
        await readFile(recordPath, "utf8"),
      ) as ContainerRecord;
      if (
        record.schemaVersion !== 1 ||
        record.workspacePath !== layout.workspacePath ||
        record.environment !== request.environment
      )
        throw new Error("环境记录身份不匹配");
      stage = "observe";
      if (request.action === "stop") {
        try {
          await reconcile(true);
        } catch (error) {
          cleanupErrors.push(`停止前对账未确认：${redact(String(error))}`);
        }
      } else await reconcile();
      if (request.action === "compose-up") {
        stage = "compose-up";
        if (record.compose === undefined || !record.compose.dataPresent)
          throw new Error("Compose 自有数据目录尚未准备");
        await verifyDataDirectory();
        await verifyProject();
        const current = record.objects.filter(
          (object) => object.state !== "absent",
        );
        if (current.length === 0) {
          const services: Record<string, unknown> = {};
          for (const service of record.compose.deployment.services) {
            const object = await add("container", service.role);
            object.composeService = service.name;
            object.usesData = true;
            services[service.name] = { labels: labels(object) };
          }
          const network = await add("network");
          network.composeNetwork = "default";
          await persist();
          await writeFile(
            record.compose.overrideFile,
            JSON.stringify({
              services,
              networks: { default: { labels: labels(network) } },
            }),
            { mode: 0o600 },
          );
        }
        output(
          await compose(
            ["up", "--detach", "--no-build"],
            request.timeoutMilliseconds ?? 60_000,
          ),
        );
        await reconcile();
        for (const task of record.objects.filter(
          (object) => object.role === "task" && object.state === "present",
        )) {
          await wait(task, "exit", request.timeoutMilliseconds ?? 60_000);
          if (task.exitCode !== 0)
            throw new Error(
              `Compose 迁移任务失败：${task.composeService} exit=${String(task.exitCode)}`,
            );
        }
        const service = record.objects.findLast(
          (object) => object.role === "service" && object.state === "present",
        );
        if (service?.id === undefined)
          throw new Error("Compose 运行服务未创建");
        record.serviceId = service.id;
        const binding = Object.values(service.ports ?? {}).flatMap(
          (ports) => ports ?? [],
        )[0];
        if (binding !== undefined)
          record.address = `http://${binding.HostIp === "0.0.0.0" ? "127.0.0.1" : binding.HostIp}:${binding.HostPort}`;
        record.generation += 1;
        await persist();
        await wait(service, "ready", request.timeoutMilliseconds ?? 60_000);
      } else if (request.action === "compose-down") {
        stage = "compose-down";
        await verifyProject();
        if (record.objects.some((object) => object.running))
          throw new Error("项目 down 前必须先确认停止");
        if (record.objects.some((object) => object.state !== "absent")) {
          requireSaved();
          output(await compose(["down"]));
          await reconcile();
          if (record.objects.some((object) => object.state !== "absent"))
            throw new Error("Compose down 后仍有自有资源");
        }
      } else if (request.action === "build") {
        stage = "build-image";
        const object = await add("image");
        output(
          await docker(
            [
              "image",
              "build",
              "--pull=false",
              "--tag",
              object.name,
              ...labelArgs(object),
              "--file",
              request.dockerfile,
              ...(request.target === undefined
                ? []
                : ["--target", request.target]),
              ...Object.entries(request.buildArguments ?? {}).flatMap(
                ([key, value]) => ["--build-arg", `${key}=${value}`],
              ),
              request.contextPath,
            ],
            false,
            600_000,
          ),
        );
        object.id = output(
          await docker([
            "image",
            "inspect",
            object.name,
            "--format",
            "{{.Id}}",
          ]),
        );
        await verify(object);
      } else if (request.action === "start") {
        stage = "create-container";
        const role = request.role ?? "service";
        const useData = request.useData ?? role !== "client";
        if (
          useData &&
          record.objects.some((object) => object.usesData && object.running)
        )
          throw new Error("同一产品数据根已有运行写入方，必须先确认停止");
        const image = request.image ?? record.image;
        const imageId = output(
          await docker(["image", "inspect", image, "--format", "{{.Id}}"]),
        );
        if (image === record.image && imageId !== record.imageId)
          throw new Error("提供方镜像引用已变化");
        const object = await add("container", role);
        object.usesData = useData;
        object.image = imageId;
        await persist();
        const volume = record.objects.find(
          (candidate) =>
            candidate.kind === "volume" && candidate.state === "present",
        );
        const network = record.objects.find(
          (candidate) =>
            candidate.kind === "network" && candidate.state === "present",
        );
        if (useData && volume === undefined)
          throw new Error("自有数据卷不存在");
        if (network === undefined) throw new Error("自有网络不存在");
        const args = [
          "container",
          "create",
          "--name",
          object.name,
          ...labelArgs(object),
          "--network",
          network.id!,
          ...(useData
            ? [
                "--mount",
                `type=volume,source=${volume!.name},target=/data${request.dataReadonly ? ",readonly" : ""}`,
              ]
            : []),
          ...[...record.mounts, ...(request.mounts ?? [])].flatMap((mount) => [
            "--mount",
            `type=bind,source=${mount.source},target=${mount.target},readonly`,
          ]),
          ...Object.entries({
            ...record.configuration,
            ...request.configuration,
          }).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
          ...(request.entrypoint === undefined
            ? []
            : ["--entrypoint", request.entrypoint]),
          ...(request.publish === undefined
            ? []
            : [
                "--publish",
                `${request.publish.hostIp}:${String(request.publish.hostPort)}:${String(request.publish.containerPort)}`,
              ]),
          imageId,
          ...(request.command ?? []),
        ];
        object.id = output(await docker(args));
        await verify(object);
        await persist();
        stage = "start-container";
        output(await docker(["container", "start", object.id!]));
        record.generation += 1;
        if (role === "service") {
          record.serviceId = object.id;
          await verify(object);
          if (request.publish !== undefined) {
            const binding =
              object.ports?.[
                `${String(request.publish.containerPort)}/tcp`
              ]?.[0];
            if (
              binding === undefined ||
              Number(binding.HostPort) !== request.publish.hostPort
            )
              throw new Error("实际发布端口与请求不符");
            record.address = `http://${binding.HostIp === "0.0.0.0" ? "127.0.0.1" : binding.HostIp}:${binding.HostPort}`;
          }
        }
        await persist();
        stage = "wait";
        await wait(
          object,
          request.waitFor,
          request.timeoutMilliseconds ?? 60_000,
        );
      } else if (
        request.action === "wait" ||
        request.action === "exec" ||
        request.action === "export"
      ) {
        const object = record.objects.find(
          (candidate) =>
            candidate.kind === "container" && candidate.id === request.objectId,
        );
        if (object === undefined || (await verify(object)) === undefined)
          throw new Error("没有可操作的自有容器身份");
        stage = request.action;
        if (request.action === "wait")
          await wait(
            object,
            request.condition,
            request.timeoutMilliseconds ?? 60_000,
          );
        else if (request.action === "export") {
          if (object.running) throw new Error("关闭诊断导出必须先确认停止");
          output(
            await docker(
              [
                "container",
                "export",
                "--output",
                request.destination,
                object.id!,
              ],
              false,
              600_000,
            ),
          );
        } else {
          const result = await docker([
            "container",
            "exec",
            ...(request.user === undefined ? [] : ["--user", request.user]),
            object.id!,
            ...request.command,
          ]);
          commandResult = {
            exitCode: result.exitCode,
            signal: result.signal,
            stdout: redact(result.stdout ?? ""),
            stderr: redact(result.stderr ?? ""),
          };
          record.generation += 1;
          output(result);
        }
      } else if (request.action === "stop") {
        stage = "stop";
        await stop();
      } else if (request.action === "save") {
        stage = "save";
        if (record.objects.some((object) => object.running))
          throw new Error("离线数据保存必须先确认所有自有容器停止");
        await collectLogs();
        await mkdir(request.directory, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(request.directory, "deployment.json"),
          redact(JSON.stringify(record, null, 2)),
          { mode: 0o600 },
        );
        if (request.includeData) {
          if (record.compose !== undefined) {
            await verifyDataDirectory();
            await cp(
              layout.productDataRoot,
              path.join(request.directory, "product-data"),
              { recursive: true, errorOnExist: true, force: false },
            );
          } else {
            const carrier = record.objects.findLast(
              (object) =>
                object.kind === "container" &&
                object.usesData &&
                object.state === "present",
            );
            if (carrier === undefined || (await verify(carrier)) === undefined)
              throw new Error("没有保留的数据载体可供完整复制");
            const data = path.join(request.directory, "product-data");
            await mkdir(data, { mode: 0o700 });
            output(
              await docker(
                ["container", "cp", `${carrier.id!}:/data/.`, data],
                false,
                600_000,
              ),
            );
          }
        }
        if (saveErrors.length > 0) throw new Error("诊断尚未完整保存");
        record.evidence = {
          directory: request.directory,
          generation: record.generation,
          dataSaved: request.includeData === true,
        };
        evidence = {
          directory: request.directory,
          dataSaved: request.includeData === true,
        };
      } else if (request.action === "delete") {
        stage = "delete";
        if (record.objects.some((object) => object.running))
          throw new Error("删除前必须明确停止");
        const pending = record.objects.filter(
          (object) =>
            object.state !== "absent" &&
            (object.kind !== "volume" || request.deleteData),
        );
        if (
          pending.length > 0 ||
          (request.deleteData && record.compose?.dataPresent)
        )
          requireSaved(
            pending.some((object) => object.kind === "volume") ||
              (request.deleteData === true &&
                record.compose?.dataPresent === true),
          );
        for (const kind of [
          "container",
          "network",
          "image",
          ...(request.deleteData ? ["volume" as const] : []),
        ] as const)
          for (const object of record.objects.filter(
            (candidate) =>
              candidate.kind === kind && candidate.state !== "absent",
          )) {
            if ((await verify(object)) === undefined) continue;
            output(
              await docker([
                kind,
                "rm",
                kind === "image" ? object.name : (object.id ?? object.name),
              ]),
            );
            if ((await verify(object)) !== undefined)
              throw new Error("对象删除未确认");
            await persist();
          }
        if (request.deleteData && record.compose?.dataPresent) {
          await verifyDataDirectory();
          await rm(layout.productDataRoot, { recursive: true });
          record.compose.dataPresent = false;
        }
      }
    }
  } catch (error) {
    failure = {
      stage,
      message: redact(error instanceof Error ? error.message : String(error)),
    };
    if (record !== undefined && stopsOnFailure) {
      record.hasFailure = true;
      const closed = await held.close();
      cleanupErrors.push(...closed.errors);
      try {
        await reconcile(true);
      } catch (reconcileError) {
        cleanupErrors.push(`创建对账未确认：${redact(String(reconcileError))}`);
      }
      await stop();
      cleanupAttempted = true;
    }
  } finally {
    offCancel();
    try {
      await persist();
    } catch (error) {
      saveErrors.push(`环境记录保存失败：${redact(String(error))}`);
    }
    observation = await observe();
    // 最终持久化/HTTP 观察仍可能收到取消；成功离开 try 不代表可以遗留服务。
    if (
      cancellation.triggered() &&
      record !== undefined &&
      stopsOnFailure &&
      !cleanupAttempted
    ) {
      failure ??= { stage, message: redact(cancellation.reason()) };
      record.hasFailure = true;
      await stop();
      try {
        await persist();
      } catch (error) {
        saveErrors.push(`停止后环境记录保存失败：${redact(String(error))}`);
      }
      observation = await observe();
    }
  }
  const unknown =
    observationUnknown ||
    (record?.objects.some((object) => object.state === "unknown") ??
      record === undefined);
  return {
    operation: request.action,
    status: cancellation.triggered()
      ? "cancelled"
      : failure !== undefined ||
          saveErrors.length > 0 ||
          cleanupErrors.length > 0
        ? unknown
          ? "unknown"
          : "failed"
        : "ok",
    ...(observation === undefined ? {} : { observation }),
    ...(failure === undefined ? {} : { failure }),
    saveErrors,
    cleanupErrors,
    logs,
    remaining:
      record?.objects.filter((object) => object.state !== "absent") ?? [],
    ...(commandResult === undefined ? {} : { command: commandResult }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}
