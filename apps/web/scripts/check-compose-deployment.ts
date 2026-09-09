import { spawn } from "node:child_process";
import { chmod, chown, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryParent = await safeTemporaryParent(
  process.env.DIGITAL_COMPOSE_CHECK_ROOT ?? tmpdir(),
);
const { nonce, root } = await createOwnedRoot(temporaryParent);
const project = nonce;
const port = String(39_000 + (process.pid % 1_000));
const productData = path.join(root, "product-data");
const observed = path.join(root, "observed");
const failedData = path.join(root, "failed-product-data");
const stoppedContainerExport = path.join(root, "stopped-web.tar");
const uid = process.env.DIGITAL_COMPOSE_CHECK_UID ?? "1001";
const gid = process.env.DIGITAL_COMPOSE_CHECK_GID ?? "1001";
const abortController = new AbortController();

async function safeTemporaryParent(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  if (candidate !== resolved || resolved === path.parse(resolved).root) {
    throw new Error("DIGITAL_COMPOSE_CHECK_ROOT 必须是已有的绝对临时父目录");
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error("DIGITAL_COMPOSE_CHECK_ROOT 必须是已有的绝对目录");
  }
  return resolved;
}

async function createOwnedRoot(
  parent: string,
): Promise<{ nonce: string; root: string }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = `digital-compose-check-${process.pid}-${Date.now()}-${attempt}`;
    const root = path.join(parent, nonce);
    try {
      await mkdir(root, { mode: 0o700 });
      return { nonce, root };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法原子创建 Compose 临时目录");
}

class CommandFailure extends Error {
  readonly code: number | null;
  readonly output: string;

  constructor(code: number | null, output: string) {
    super(output);
    this.code = code;
    this.output = output;
  }
}

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env,
      signal: abortController.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new CommandFailure(
              code,
              `${command} ${args.join(" ")} exited ${code}\n${output}`,
            ),
          ),
    );
  });
}

function compose(
  args: readonly string[],
  environment = environmentFor(productData, port, uid, gid),
) {
  return run(
    "docker",
    ["compose", "--project-name", project, ...args],
    environment,
  );
}

function environmentFor(
  data: string,
  publishedPort: string,
  configuredUid: string,
  configuredGid: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DIGITAL_UID: configuredUid,
    DIGITAL_GID: configuredGid,
    DIGITAL_PRODUCT_DATA_HOST_PATH: data,
    DIGITAL_OBSERVED_ROOT_HOST_PATH: observed,
    DIGITAL_BIND_ADDRESS: "127.0.0.1",
    DIGITAL_PORT: publishedPort,
    DIGITAL_MIGRATION_IMAGE: `${nonce}-migration`,
    DIGITAL_RUNTIME_IMAGE: `${nonce}-runtime`,
  };
}

async function waitReady(publishedPort: string): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const ready = await fetch(`http://127.0.0.1:${publishedPort}/api/ready`);
      if (ready.ok) return;
    } catch {
      /* 启动中 */
    }
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }
  throw new Error("Compose Web 未在 60 秒内 ready");
}

async function waitHealthy(): Promise<void> {
  let lastStatus = "unknown";
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const health = await run("docker", [
      "inspect",
      "--format={{.State.Health.Status}}",
      `${project}-web-1`,
    ]);
    lastStatus = health.trim();
    if (lastStatus === "healthy") return;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }
  throw new Error(
    `Compose 健康检查未在 90 秒内变为 healthy，最后状态：${lastStatus}\n${await healthDiagnostics()}`,
  );
}

async function healthDiagnostics(): Promise<string> {
  const [state, logs, ready] = await Promise.all([
    run("docker", [
      "inspect",
      "--format={{json .State}}",
      `${project}-web-1`,
    ]).catch((error) => String(error)),
    compose(["logs", "--no-color", "--tail", "50", "web"]).catch((error) =>
      String(error),
    ),
    fetch(`http://127.0.0.1:${port}/api/ready`)
      .then((response) => `HTTP ${response.status}`)
      .catch((error) => String(error)),
  ]);
  return [
    `容器状态：${redactDiagnostic(state)}`,
    `最后 Web 日志：${redactDiagnostic(logs)}`,
    `最终 readiness：${ready}`,
  ].join("\n");
}

function redactDiagnostic(value: string): string {
  return value.replace(
    /((?:token|password|secret|authorization)[^\s=:]*[=:])\S+/giu,
    "$1[已隐藏]",
  );
}

async function expectComposeFailure(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await compose(args, environment);
  } catch {
    return;
  }
  throw new Error("预期 Compose 启动失败，但命令成功");
}

async function execInWeb(script: string): Promise<string> {
  return await compose(["exec", "-T", "web", "sh", "-ceu", script]);
}

async function assertWebIsNotRunning(): Promise<void> {
  const output = await run("docker", [
    "inspect",
    "--format={{.State.Running}}",
    `${project}-web-1`,
  ]);
  if (output.trim() !== "false") throw new Error("失败迁移后 Web 仍在运行");
}

async function seedAndAssertPersistence(): Promise<void> {
  const sql = [
    "INSERT INTO observed_root_registrations VALUES ('compose-check-root','Compose check','/observed/media','/observed/media','active',1,1,'never','[]');",
    "INSERT INTO workflow_executions (id,status,stage,outcome,source_record_ids_json,compatibility_json,information_requirement_json) VALUES ('compose-check-execution','completed','completed','accepted','[]','{}','{}');",
    "INSERT INTO recognition_proposals VALUES ('compose-check-proposal','compose-check-execution','{}','[]');",
    "INSERT INTO recognition_decisions VALUES ('compose-check-decision','compose-check-proposal','compose-check-recognized-asset','[]');",
  ].join(" ");
  const encoded = Buffer.from(sql).toString("base64");
  await compose([
    "exec",
    "-T",
    "-e",
    `CHECK_SQL=${encoded}`,
    "web",
    "node",
    "--input-type=module",
    "--eval",
    "const moduleName = 'node:' + 'sqlite'; const { DatabaseSync } = await import(moduleName); const db = new DatabaseSync('/data/catalogue.sqlite'); db.exec(Buffer.from(process.env.CHECK_SQL, 'base64').toString()); db.close();",
  ]);
  await mkdir(path.join(productData, "private-source-connections"), {
    recursive: true,
    mode: 0o700,
  });
  const connectionDirectory = path.join(
    productData,
    "private-source-connections",
  );
  const connection = path.join(connectionDirectory, "tmdb.json");
  await writeFile(
    connection,
    '{"version":"product-source-connection/1","configurationVersion":1,"credentialStatus":"revoked","availability":"unavailable","reason":"revoked"}',
    { mode: 0o600 },
  );
  await Promise.all([
    chown(connectionDirectory, Number(uid), Number(gid)),
    chown(connection, Number(uid), Number(gid)),
  ]);
}

async function assertPersistedState(): Promise<void> {
  const query =
    "const moduleName = 'node:' + 'sqlite'; const { DatabaseSync } = await import(moduleName); const db = new DatabaseSync('/data/catalogue.sqlite',{readOnly:true}); const result={root:db.prepare(\"SELECT container_path FROM observed_root_registrations WHERE id='compose-check-root'\").get(),execution:db.prepare(\"SELECT status FROM workflow_executions WHERE id='compose-check-execution'\").get(),asset:db.prepare(\"SELECT asset_id FROM recognition_decisions WHERE id='compose-check-decision'\").get()}; console.log(JSON.stringify(result)); db.close();";
  const output = await compose([
    "exec",
    "-T",
    "web",
    "node",
    "--input-type=module",
    "--eval",
    query,
  ]);
  if (
    !output.includes("/observed/media") ||
    !output.includes("completed") ||
    !output.includes("compose-check-recognized-asset")
  )
    throw new Error(`重建后 Catalogue 状态丢失：${output}`);
  await execInWeb(
    "test -f /data/private-source-connections/tmdb.json; test -f /data/non-root-write-proof",
  );
}

async function stopWebAndAssertShutdown(): Promise<void> {
  const startedAt = Date.now();
  await compose(["stop", "web"]);
  const elapsedMilliseconds = Date.now() - startedAt;
  if (elapsedMilliseconds >= 10_000)
    throw new Error(
      `Compose Web 未在默认 10 秒停止窗内结束：${elapsedMilliseconds}ms`,
    );

  const rawState = await run("docker", [
    "inspect",
    "--format={{json .State}}",
    `${project}-web-1`,
  ]);
  const state = JSON.parse(rawState) as {
    readonly Running?: unknown;
    readonly Pid?: unknown;
    readonly OOMKilled?: unknown;
    readonly ExitCode?: unknown;
  };
  if (
    state.Running !== false ||
    state.Pid !== 0 ||
    state.OOMKilled !== false ||
    state.ExitCode !== 143
  )
    throw new Error(`Compose Web 停止状态不符合正常关闭合同：${rawState}`);

  await run("docker", [
    "export",
    "--output",
    stoppedContainerExport,
    `${project}-web-1`,
  ]);
  try {
    for (const pattern of [
      "tmp/digital-web-process-*",
      "tmp/digital-fanbox-browser-*",
      "tmp/playwright_chromiumdev_profile-*",
    ]) {
      try {
        const entries = await run("tar", [
          "--list",
          "--file",
          stoppedContainerExport,
          "--wildcards",
          "--no-anchored",
          pattern,
        ]);
        if (entries.trim())
          throw new Error(`停止容器仍有临时 owner：${entries.trim()}`);
      } catch (error) {
        if (error instanceof CommandFailure && error.code === 2) continue;
        throw error;
      }
    }
  } finally {
    await rm(stoppedContainerExport, { force: true });
  }
}

async function assertRootConfigurationRejected(
  configuredUid: string,
  configuredGid: string,
): Promise<void> {
  await compose(
    ["down", "--remove-orphans"],
    environmentFor(productData, port, configuredUid, configuredGid),
  ).catch(() => undefined);
  await expectComposeFailure(
    ["up", "-d"],
    environmentFor(productData, port, configuredUid, configuredGid),
  );
  await assertWebIsNotRunning();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () =>
    abortController.abort(new Error(`收到 ${signal}`)),
  );
}

try {
  await run("docker", ["compose", "version"]);
  await mkdir(productData, { recursive: true, mode: 0o750 });
  await mkdir(observed, { recursive: true, mode: 0o750 });
  await mkdir(path.join(failedData, "catalogue.sqlite"), {
    recursive: true,
    mode: 0o750,
  });
  const probe = path.join(observed, "probe.txt");
  await writeFile(probe, "synthetic-observed-root", { mode: 0o440 });
  await Promise.all([
    chown(productData, Number(uid), Number(gid)),
    chown(observed, Number(uid), Number(gid)),
    chown(probe, Number(uid), Number(gid)),
    chown(failedData, Number(uid), Number(gid)),
    chmod(productData, 0o750),
    chmod(observed, 0o750),
  ]);
  await compose(["up", "-d", "--build"]);
  await waitReady(port);
  const live = await fetch(`http://127.0.0.1:${port}/api/live`);
  if (!live.ok) throw new Error("Compose Web 未通过 liveness");
  await waitHealthy();
  await execInWeb(
    `test "$(id -u)" = ${uid}; test "$(id -g)" = ${gid}; test "$(cat /observed/media/probe.txt)" = synthetic-observed-root; touch /data/non-root-write-proof; ! touch /observed/media/must-remain-read-only`,
  );
  await seedAndAssertPersistence();
  await stopWebAndAssertShutdown();
  await compose(["down"]);
  await compose(["up", "-d"]);
  await waitReady(port);
  await assertPersistedState();
  await compose(["down"]);
  await expectComposeFailure(
    ["up", "-d"],
    environmentFor(failedData, String(Number(port) + 1), uid, gid),
  );
  await assertWebIsNotRunning();
  await assertRootConfigurationRejected("0", gid);
  await assertRootConfigurationRejected(uid, "0");
} finally {
  try {
    await cleanup();
    await assertCleanup();
  } finally {
    await rm(root, { recursive: true, force: false });
  }
}

async function cleanup(): Promise<void> {
  await compose(["down", "--remove-orphans"]).catch(() => undefined);
  await run("docker", [
    "image",
    "rm",
    "--force",
    `${nonce}-migration`,
    `${nonce}-runtime`,
  ]).catch(() => undefined);
}

async function assertCleanup(): Promise<void> {
  const names = [
    `${project}-web-1`,
    `${project}-migrate-1`,
    `${project}_default`,
    `${nonce}-migration`,
    `${nonce}-runtime`,
  ];
  const kinds = ["container", "container", "network", "image", "image"];
  for (const [index, name] of names.entries()) {
    try {
      await run("docker", [kinds[index]!, "inspect", name]);
    } catch (error) {
      if (isMissingInspection(error)) continue;
      throw error;
    }
    throw new Error(`Compose checker 残留 ${kinds[index]} ${name}`);
  }
  const volumes = await run("docker", [
    "volume",
    "ls",
    "--quiet",
    "--filter",
    `name=${project}`,
  ]);
  if (volumes.trim())
    throw new Error(`Compose checker 残留 volume ${volumes.trim()}`);
}

function isMissingInspection(error: unknown): boolean {
  return (
    error instanceof CommandFailure &&
    error.code === 1 &&
    /(?:No such (?:container|network|image)|network .+ not found)/u.test(
      error.output,
    )
  );
}
