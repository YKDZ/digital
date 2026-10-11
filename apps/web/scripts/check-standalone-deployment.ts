import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  manageContainerEnvironment,
  type ContainerEndpoint,
  type ContainerOperationResult,
  type ContainerReference,
  type ContainerRequest,
} from "@digital/environment/container";

import { fileCommandJournal, runCommand } from "./environment-lifecycle.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const uniqueId = `completion-15-${process.pid}-${Date.now()}`;
const artifacts = path.resolve(
  process.env.DIGITAL_DEPLOYMENT_ARTIFACTS ?? `.scratch/deployment/${uniqueId}`,
);
const standaloneImage = process.env.DIGITAL_DEPLOYMENT_STANDALONE_IMAGE;
const runtimeImage = process.env.DIGITAL_DEPLOYMENT_RUNTIME_IMAGE;
if (!standaloneImage || !runtimeImage)
  throw new Error("必须显式提供已构建的 standalone 和 runtime 镜像引用");
const endpoint: ContainerEndpoint = {
  command: process.env.DIGITAL_DEPLOYMENT_DOCKER_COMMAND ?? "docker",
  arguments: JSON.parse(
    process.env.DIGITAL_DEPLOYMENT_DOCKER_ARGUMENTS ?? "[]",
  ) as string[],
  host: process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock",
};
const port = Number(process.env.DIGITAL_DEPLOYMENT_PORT ?? "8080");
const fixture = path.join(repositoryRoot, "fixtures/controlled-source-io");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort(new Error(`收到 ${signal}`)));
const environments: ContainerReference[] = [];
const operations: unknown[] = [];
const resumeEnvironment = process.env.DIGITAL_DEPLOYMENT_RESUME_ENVIRONMENT;
const resumeStage = process.env.DIGITAL_DEPLOYMENT_RESUME_STAGE;
const browserAlreadyVerified =
  resumeStage === "after-browser" || resumeStage === "after-browser-and-owner";
const standaloneOwnerAlreadyVerified =
  resumeStage === "after-browser-and-owner";
const archiveCommand = process.env.DIGITAL_DEPLOYMENT_ARCHIVE_COMMAND ?? "tar";
const archiveArguments = JSON.parse(
  process.env.DIGITAL_DEPLOYMENT_ARCHIVE_ARGUMENTS ?? "[]",
) as string[];
const saveErrors: string[] = [];
const cleanupErrors: string[] = [];
let mainError: string | undefined;

async function operate(
  request: ContainerRequest,
  cleanup = false,
): Promise<ContainerOperationResult> {
  const startedAt = new Date().toISOString();
  const result = await manageContainerEnvironment(
    request,
    cleanup ? {} : { signal: controller.signal },
  );
  console.log(
    JSON.stringify({
      environment: request.environment,
      action: request.action,
      status: result.status,
      finishedAt: new Date().toISOString(),
      failure: result.failure,
    }),
  );
  operations.push({
    request,
    startedAt,
    finishedAt: new Date().toISOString(),
    result,
  });
  try {
    await writeFile(
      path.join(artifacts, "operations.json"),
      JSON.stringify(operations, null, 2),
    );
  } catch (error) {
    saveErrors.push(String(error));
  }
  return result;
}
function requireSuccess(
  result: ContainerOperationResult,
): ContainerOperationResult {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result;
}
async function prepare(
  name: string,
  mounts = false,
): Promise<ContainerReference> {
  const reference = {
    workspacePath: repositoryRoot,
    environment: `${uniqueId}-${name}`,
  };
  environments.push(reference);
  requireSuccess(
    await operate({
      ...reference,
      action: "prepare",
      endpoint,
      image: standaloneImage!,
      ...(mounts
        ? {
            mounts: [
              {
                source: fixture,
                target: "/controlled-source",
                readonly: true as const,
              },
            ],
            configuration: {
              DIGITAL_SOURCE_IO_MODE: "controlled",
              DIGITAL_SOURCE_IO_CONFIG: "/controlled-source/manifest.json",
              DIGITAL_SOURCE_IO_IDENTITY:
                "sha256:0595bf9c66f739a60b67ac434391e7e274d5f268df5509637c48b73c4fefa6e8",
            },
          }
        : {}),
    }),
  );
  return reference;
}
async function start(
  reference: ContainerReference,
  image = standaloneImage!,
  waitFor: "ready" | "live" = "ready",
) {
  return requireSuccess(
    await operate({
      ...reference,
      action: "start",
      image,
      publish: { hostIp: "0.0.0.0", hostPort: port, containerPort: 3000 },
      waitFor,
    }),
  );
}
function serviceOf(result: ContainerOperationResult) {
  const service = result.observation?.objects.findLast(
    (object) => object.role === "service",
  );
  assert.ok(service?.id);
  return service;
}
async function stopped(
  reference: ContainerReference,
  normal = true,
  owners = false,
) {
  const result = requireSuccess(
    await operate({ ...reference, action: "stop" }, true),
  );
  if (normal) {
    const service = serviceOf(result);
    assert.equal(service.running, false);
    assert.equal(service.pid, 0);
    assert.equal(service.exitCode, 143);
    assert.equal(service.oomKilled, false);
    assert.ok(
      (service.stopDurationMilliseconds ?? Infinity) < 10_000,
      JSON.stringify(service),
    );
    if (owners) {
      const destination = path.join(
        artifacts,
        `${service.key}-stopped-container.tar`,
      );
      requireSuccess(
        await operate(
          {
            ...reference,
            action: "export",
            objectId: service.id!,
            destination,
          },
          true,
        ),
      );
      for (const pattern of [
        "tmp/digital-web-process-*",
        "tmp/digital-fanbox-browser-*",
        "tmp/playwright_chromiumdev_profile-*",
      ]) {
        const listing = await runCommand({
          phase: "shutdown-owner",
          command: archiveCommand,
          args: [
            ...archiveArguments,
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
          listing.stdoutTail.trim(),
          "",
          `停止后仍有临时owner：${pattern}`,
        );
        assert.ok(
          listing.exitCode === 0 ||
            (listing.exitCode === 2 &&
              listing.stderrTail.includes("Not found in archive")),
          JSON.stringify(listing),
        );
        assert.equal(listing.journalError, undefined);
      }
    }
  }
  return result;
}
async function task(
  reference: ContainerReference,
  script?: string,
  dataReadonly = false,
) {
  const result = requireSuccess(
    await operate({
      ...reference,
      action: "start",
      role: "task",
      waitFor: "exit",
      dataReadonly,
      ...(script === undefined
        ? { command: ["prepare-only"] }
        : {
            entrypoint: "node",
            command: ["--input-type=module", "--eval", script],
          }),
    }),
  );
  const object = result.observation?.objects.findLast(
    (candidate) => candidate.role === "task",
  );
  assert.equal(object?.running, false);
  assert.equal(object?.exitCode, 0);
  return object!;
}
async function sql(reference: ContainerReference, statement: string) {
  await task(
    reference,
    `const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('/data/catalogue.sqlite'); db.exec(${JSON.stringify(statement)}); db.close();`,
  );
}
async function http(
  reference: ContainerReference,
  pathname: string,
  expected: number,
) {
  const result = requireSuccess(
    await operate({ ...reference, action: "inspect" }),
  );
  const response = await fetch(
    new URL(pathname, result.observation!.address!),
    { signal: AbortSignal.timeout(5_000) },
  );
  assert.equal(
    response.status,
    expected,
    `${reference.environment} ${pathname}`,
  );
  return response;
}
async function finish(reference: ContainerReference) {
  requireSuccess(await operate({ ...reference, action: "stop" }, true));
  const saved = await operate(
    {
      ...reference,
      action: "save",
      directory: path.join(artifacts, reference.environment),
      includeData: true,
    },
    true,
  );
  requireSuccess(saved);
  requireSuccess(
    await operate({ ...reference, action: "delete", deleteData: true }, true),
  );
  requireSuccess(
    await operate({ ...reference, action: "delete", deleteData: true }, true),
  );
  assert.equal(
    requireSuccess(await operate({ ...reference, action: "inspect" }, true))
      .remaining.length,
    0,
  );
}
async function materialDigest(): Promise<string> {
  const root = path.join(fixture, "material");
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(path.relative(root, file));
    digest.update(await readFile(file));
  }
  return digest.digest("hex");
}
async function browser(
  reference: ContainerReference,
  running: ContainerOperationResult,
) {
  const containerClient =
    process.env.DIGITAL_DEPLOYMENT_PLAYWRIGHT_CLIENT === "container";
  const baseUrl = containerClient
    ? `http://${serviceOf(running).name}:3000`
    : (process.env.DIGITAL_DEPLOYMENT_BROWSER_BASE_URL ??
      running.observation!.address!);
  const handoff = path.join(artifacts, "browser-handoff.json");
  await writeFile(
    handoff,
    JSON.stringify({
      mode: "provided",
      baseUrl,
      environment: reference.environment,
      workspacePath: repositoryRoot,
      productDataRoot: "/data",
      materialDirectory: "/controlled-source/material/RJ01668691",
      manifestPath: path.join(fixture, "manifest.json"),
      sourceMode: "controlled",
      productLogFile: "",
      run: {
        port: Number(new URL(baseUrl).port),
        runId: running.observation!.runId,
      },
      artifactsDirectory: artifacts,
    }),
  );
  if (containerClient) {
    const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!browsers)
      throw new Error("容器浏览器要求显式 PLAYWRIGHT_BROWSERS_PATH");
    let clientImage = running.observation?.objects.findLast(
      (object) => object.kind === "image" && object.state === "present",
    );
    if (clientImage === undefined) {
      const built = requireSuccess(
        await operate({
          ...reference,
          action: "build",
          contextPath: repositoryRoot,
          dockerfile: path.join(
            repositoryRoot,
            "apps/web/Dockerfile.playwright-client",
          ),
        }),
      );
      clientImage = built.observation?.objects.findLast(
        (object) => object.kind === "image",
      );
    }
    assert.ok(clientImage?.id);
    const clientRun = requireSuccess(
      await operate({
        ...reference,
        action: "start",
        role: "client",
        image: clientImage.id,
        useData: false,
        entrypoint: "node",
        waitFor: "exit",
        timeoutMilliseconds: 600_000,
        mounts: [
          { source: repositoryRoot, target: "/workspace", readonly: true },
          { source: browsers, target: "/playwright-browsers", readonly: true },
          { source: handoff, target: "/browser-handoff.json", readonly: true },
        ],
        configuration: {
          DIGITAL_ACCEPTANCE_HANDOFF: "/browser-handoff.json",
          PLAYWRIGHT_EXTERNAL_BASE_URL: baseUrl,
          PLAYWRIGHT_BROWSERS_PATH: "/playwright-browsers",
        },
        command: [
          "/workspace/apps/web/node_modules/@playwright/test/cli.js",
          "test",
          "--config",
          "/workspace/apps/web/playwright.acceptance.config.ts",
          "managed-service-product-chain.spec.ts",
          "--grep",
          "浏览器从空白正式迁移起步",
          "--output=/tmp/browser-artifacts",
        ],
      }),
    );
    const client = clientRun.observation?.objects.findLast(
      (object) => object.role === "client",
    );
    assert.equal(client?.exitCode, 0);
    assert.equal(client?.running, false);
    requireSuccess(
      await operate({
        ...reference,
        action: "export",
        objectId: client!.id!,
        destination: path.join(artifacts, "browser-client-diagnostic.tar"),
      }),
    );
    assert.equal(
      requireSuccess(await operate({ ...reference, action: "inspect" }))
        .observation?.serviceReady,
      true,
    );
    return;
  }
  const input = process.env.DIGITAL_DEPLOYMENT_BROWSER_ARGUMENTS;
  const args =
    input === undefined
      ? [
          "--dir",
          "apps/web",
          "exec",
          "playwright",
          "test",
          "--config",
          "playwright.acceptance.config.ts",
          "test/e2e/managed-service-product-chain.spec.ts",
          "--grep",
          "浏览器从空白正式迁移起步",
          `--output=${path.join(artifacts, "browser")}`,
        ]
      : (JSON.parse(input) as string[]);
  const result = await runCommand({
    phase: "browser",
    command: process.env.DIGITAL_DEPLOYMENT_BROWSER_COMMAND ?? "pnpm",
    args,
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DIGITAL_ACCEPTANCE_HANDOFF: handoff,
      PLAYWRIGHT_EXTERNAL_BASE_URL: baseUrl,
    },
    signal: controller.signal,
    journal: fileCommandJournal(
      path.join(artifacts, "browser-commands.ndjson"),
    ),
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.signal, null);
  assert.equal(result.journalError, undefined);
  // 浏览器退出后只观察；部署的 stop/save/delete 仍由本调用方执行。
  assert.equal(
    requireSuccess(await operate({ ...reference, action: "inspect" }))
      .observation?.serviceReady,
    true,
  );
}

await mkdir(artifacts, { recursive: true, mode: 0o700 });
try {
  if (resumeEnvironment === undefined) {
    const empty = await prepare("empty");
    const emptyRun = await start(empty);
    assert.equal(emptyRun.observation?.serviceReady, true);
    await http(empty, "/api/catalogue", 200);
    await stopped(empty);
    await finish(empty);
  }
  const prepared =
    resumeEnvironment === undefined
      ? await prepare("prepared", true)
      : { workspacePath: repositoryRoot, environment: resumeEnvironment };
  if (resumeEnvironment === undefined) {
    const prepareOnly = await task(prepared);
    assert.equal(Object.keys(prepareOnly.ports ?? {}).length, 0);
  } else {
    environments.push(prepared);
    // 显式接续已登记环境；先保全上次失败数据，不重做已证明的空卷/仅准备步骤。
    requireSuccess(
      await operate(
        {
          ...prepared,
          action: "save",
          directory: path.join(artifacts, "prior-failure-saved"),
          includeData: true,
        },
        true,
      ),
    );
  }
  const digestBefore = await materialDigest();
  const running = await start(prepared);
  if (!browserAlreadyVerified) {
    const service = serviceOf(running);
    const identity = requireSuccess(
      await operate({
        ...prepared,
        action: "exec",
        objectId: service.id!,
        command: [
          "node",
          "--input-type=module",
          "--eval",
          "import fs from 'node:fs'; const status=fs.readFileSync('/proc/1/status','utf8'); if(!/^Uid:[ \t]+1001[ \t]+1001[ \t]+1001[ \t]+1001$/m.test(status)||!/^Gid:[ \t]+1001[ \t]+1001[ \t]+1001[ \t]+1001$/m.test(status))throw Error('PID1 identity'); if(process.getuid()!==1001 || process.getgid()!==1001) throw Error('wrong identity'); fs.writeFileSync('/data/permission-proof','writable'); let denied=false;try{fs.writeFileSync('/controlled-source/material/RJ01668691/forbidden','x')}catch(e){denied=e.code==='EROFS'||e.code==='EACCES'}if(!denied)throw Error('material writable'); console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),dataWritable:true,materialReadonly:denied}));",
        ],
      }),
    );
    assert.ok(identity.command?.stdout.includes('"uid":1001'));
    await browser(prepared, running);
  }
  const beforeRestart = (await (
    await http(prepared, "/api/settings", 200)
  ).json()) as { libraries: { id: string; displayName: string }[] };
  const created = beforeRestart.libraries.find(
    (library) => library.displayName === "受控夹具资产库已改名",
  );
  assert.ok(created);
  await stopped(prepared, true, !standaloneOwnerAlreadyVerified);
  await start(prepared, runtimeImage);
  const afterRestart = (await (
    await http(prepared, "/api/settings", 200)
  ).json()) as typeof beforeRestart;
  assert.equal(
    afterRestart.libraries.find((library) => library.id === created.id)
      ?.displayName,
    created.displayName,
  );
  await http(prepared, "/api/catalogue", 200);
  assert.equal(await materialDigest(), digestBefore);
  await stopped(prepared, true, true);
  await finish(prepared);

  for (const [name, statement] of [
    ["unprepared", undefined],
    [
      "future",
      "INSERT INTO __digital_catalogue_migrations (id, checksum, applied_at) VALUES ('99999999999999_future', 'future', '2026-08-20T00:00:00.000Z')",
    ],
    [
      "failed",
      "INSERT INTO __digital_catalogue_migration_failures (id, message, occurred_at) VALUES ('20260820000000_v1_catalogue_baseline', 'failed', '2026-08-20T00:00:00.000Z')",
    ],
  ] as const) {
    const reference = await prepare(name);
    if (statement !== undefined) {
      await task(reference);
      await sql(reference, statement);
    }
    const runtime = await start(reference, runtimeImage, "live");
    assert.equal(runtime.observation?.serviceReady, false);
    await http(reference, "/api/ready", 503);
    await http(reference, "/api/catalogue", 503);
    await stopped(reference);
    await finish(reference);
  }

  const damaged = await prepare("damaged");
  await task(damaged);
  const marker = "standalone-retained-before-failure",
    secret = "standalone-secret-must-not-appear";
  await sql(
    damaged,
    `INSERT INTO schema_migrations (id, applied_at) VALUES ('${marker}', '2026-08-20T00:00:00.000Z'); INSERT INTO schema_migrations (id, applied_at) VALUES ('${secret}', '2026-08-20T00:00:00.000Z'); DROP INDEX workflow_executions_reuse; DELETE FROM __digital_catalogue_migrations;`,
  );
  const failed = await operate({
    ...damaged,
    action: "start",
    waitFor: "ready",
    publish: { hostIp: "0.0.0.0", hostPort: port, containerPort: 3000 },
  });
  assert.equal(failed.status, "failed");
  assert.ok(failed.failure);
  assert.equal(failed.observation?.serviceReady, false);
  const failedService = serviceOf(failed);
  assert.equal(failedService.running, false);
  assert.notEqual(failedService.exitCode, 0);
  let live = false;
  try {
    live = (await fetch(`http://127.0.0.1:${port}/api/live`)).ok;
  } catch {}
  assert.equal(live, false);
  const logs = (
    await Promise.all(failed.logs.map((file) => readFile(file, "utf8")))
  )
    .filter((log) => log.includes(`container logs ${failedService.id}`))
    .join("\n");
  assert.ok(logs.includes("生产数据库准备失败：生产迁移"));
  assert.ok(!logs.includes(secret));
  assert.ok(!/SQLITE|node:sqlite|\bat\s+/u.test(logs));
  await task(
    damaged,
    `const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync('/data/catalogue.sqlite',{readOnly:true});const failure=db.prepare('SELECT id,message FROM __digital_catalogue_migration_failures').get();if(failure?.id!=='20260820000000_v1_catalogue_baseline'||failure.message!=='Error')throw Error('failure ledger changed');if(!db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(${JSON.stringify(marker)}))throw Error('original state lost');console.log(JSON.stringify({failure,retained:true}));db.close();`,
  );
  // 失败现场只保存；删除留给后续明确动作，container export 不作为卷备份。
  requireSuccess(
    await operate(
      {
        ...damaged,
        action: "save",
        directory: path.join(artifacts, "damaged-retained"),
        includeData: true,
      },
      true,
    ),
  );
} catch (error) {
  mainError = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  for (const reference of environments) {
    const result = await operate({ ...reference, action: "stop" }, true);
    cleanupErrors.push(...result.cleanupErrors);
    saveErrors.push(...result.saveErrors);
    if (result.status !== "ok")
      cleanupErrors.push(
        `${reference.environment}: ${result.failure?.message ?? result.status}`,
      );
  }
  await writeFile(
    path.join(artifacts, "outcome.json"),
    JSON.stringify(
      {
        mainError: mainError ?? null,
        resumeEnvironment,
        browserAlreadyVerified,
        saveErrors,
        cleanupErrors,
        environments,
        operationsPath: path.join(artifacts, "operations.json"),
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  if (saveErrors.length > 0 || cleanupErrors.length > 0) process.exitCode = 1;
}
