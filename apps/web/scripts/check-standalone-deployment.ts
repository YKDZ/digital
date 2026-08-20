import { spawn } from "node:child_process";
import path from "node:path";

const webRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(webRoot, "../..");
const uniqueId = `${process.pid}-${Date.now()}`;
const image = `digital-deployment-check:${uniqueId}`;
const container = `digital-deployment-check-${uniqueId}`;
const runtimeImage = `digital-runtime-check:${uniqueId}`;
const runtimeContainer = `digital-runtime-check-${uniqueId}`;
const preparedVolume = `digital-prepared-check-${uniqueId}`;
const unpreparedVolume = `digital-unprepared-check-${uniqueId}`;
const futureVolume = `digital-future-check-${uniqueId}`;
const failedVolume = `digital-failed-check-${uniqueId}`;
const emptyStandaloneVolume = `digital-empty-standalone-check-${uniqueId}`;
const damagedStandaloneVolume = `digital-damaged-standalone-check-${uniqueId}`;
const emptyStandaloneContainer = `digital-empty-standalone-check-${uniqueId}`;
const damagedStandaloneContainer = `digital-damaged-standalone-check-${uniqueId}`;
const playwrightClient = `digital-playwright-check-${uniqueId}`;
const playwrightClientImage = `digital-playwright-client:${uniqueId}`;
const abortController = new AbortController();

interface CommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly includeStderr?: boolean;
  readonly signal?: AbortSignal;
  readonly timeout: number;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.env,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) {
        resolve((options.includeStderr ? `${stdout}${stderr}` : stdout).trim());
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} ${
            timedOut
              ? `timed out after ${options.timeout}ms`
              : `exited with code ${String(code)}${signal === null ? "" : ` from ${signal}`}`
          }\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
}

function docker(timeout: number, ...args: string[]): Promise<string> {
  return runCommand("docker", args, {
    signal: abortController.signal,
    timeout,
  });
}

async function cleanup(): Promise<void> {
  for (const args of [
    ["rm", "--force", container],
    ["rm", "--force", runtimeContainer],
    ["rm", "--force", emptyStandaloneContainer],
    ["rm", "--force", damagedStandaloneContainer],
    ["rm", "--force", playwrightClient],
    ["image", "rm", "--force", playwrightClientImage],
    ["image", "rm", "--force", image],
    ["image", "rm", "--force", runtimeImage],
    ["volume", "rm", "--force", preparedVolume],
    ["volume", "rm", "--force", unpreparedVolume],
    ["volume", "rm", "--force", futureVolume],
    ["volume", "rm", "--force", failedVolume],
    ["volume", "rm", "--force", emptyStandaloneVolume],
    ["volume", "rm", "--force", damagedStandaloneVolume],
  ]) {
    try {
      await runCommand("docker", args, { timeout: 30_000 });
    } catch {
      // The resource may not have been created.
    }
  }
}

async function assertCleanup(): Promise<void> {
  const resources = [
    ["container", container],
    ["container", runtimeContainer],
    ["container", emptyStandaloneContainer],
    ["container", damagedStandaloneContainer],
    ["image", image],
    ["image", runtimeImage],
    ["image", playwrightClientImage],
    ["volume", preparedVolume],
    ["volume", unpreparedVolume],
    ["volume", futureVolume],
    ["volume", failedVolume],
    ["volume", emptyStandaloneVolume],
    ["volume", damagedStandaloneVolume],
  ] as const;
  for (const [kind, name] of resources) {
    try {
      await runCommand("docker", [kind, "inspect", name], { timeout: 10_000 });
    } catch {
      continue;
    }
    throw new Error(`Deployment checker left temporary ${kind} ${name}`);
  }
}

async function containerLogs(containerName = container): Promise<string> {
  try {
    return await runCommand("docker", ["logs", containerName], {
      includeStderr: true,
      timeout: 10_000,
    });
  } catch (error) {
    return `Container logs unavailable: ${String(error)}`;
  }
}

async function waitForLive(
  baseUrl: string,
  containerName: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/live`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }

    const running = await docker(
      5_000,
      "inspect",
      "--format={{.State.Running}}",
      containerName,
    );
    if (running !== "true") {
      throw new Error(
        `Container exited before liveness.\n${await containerLogs(containerName)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Container was not live within 60000ms.\n${await containerLogs(containerName)}`,
  );
}

async function assertStatus(
  baseUrl: string,
  pathname: string,
  expected: number,
): Promise<void> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== expected) {
    throw new Error(
      `${pathname} expected ${expected}, received ${response.status}`,
    );
  }
}

async function waitForReady(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastStatus: number | undefined;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/ready`, {
        signal: AbortSignal.timeout(5_000),
      });
      lastStatus = response.status;
      if (response.status === 200) return;
    } catch {
      // Startup may still be progressing after liveness becomes available.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `/api/ready did not return 200 within 60000ms; last status ${String(lastStatus)}`,
  );
}

async function launch(
  containerName: string,
  imageName: string,
  volume: string,
): Promise<string> {
  await docker(
    30_000,
    "run",
    "--detach",
    "--name",
    containerName,
    "--mount",
    `source=${volume},target=/data`,
    "--publish",
    "127.0.0.1::3000",
    imageName,
  );
  const portOutput = await docker(10_000, "port", containerName, "3000/tcp");
  const match = /:(\d+)$/u.exec(portOutput.split("\n")[0] ?? "");
  if (!match?.[1])
    throw new Error(`Could not determine the published port: ${portOutput}`);
  const baseUrl = `http://127.0.0.1:${match[1]}`;
  await waitForLive(baseUrl, containerName);
  return baseUrl;
}

async function waitForExit(containerName: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await docker(
      5_000,
      "inspect",
      "--format={{.State.Running}} {{.State.ExitCode}}",
      containerName,
    );
    const [running, exitCode] = state.split(" ");
    if (running === "false") {
      if (exitCode !== "0") return;
      throw new Error("Damaged standalone deployment exited successfully");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Damaged standalone deployment did not exit within 60000ms");
}

async function assertNotLive(baseUrl: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/api/live`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (response.ok)
      throw new Error("Damaged standalone deployment opened Web liveness");
  } catch (error) {
    if (error instanceof Error && error.message.includes("opened Web"))
      throw error;
  }
}

async function injectLedgerFailure(volume: string, sql: string): Promise<void> {
  await docker(
    30_000,
    "run",
    "--rm",
    "--mount",
    `source=${volume},target=/data`,
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "--eval",
    `const moduleName = 'node:' + 'sqlite'; const { DatabaseSync } = await import(moduleName); const db = new DatabaseSync('/data/catalogue.sqlite'); db.exec(${JSON.stringify(sql)}); db.close();`,
  );
}

async function inspectFailedStandaloneMigration(
  volume: string,
  retainedMarker: string,
): Promise<{
  readonly failure: { readonly id: string; readonly message: string } | null;
  readonly retained: boolean;
}> {
  const output = await docker(
    30_000,
    "run",
    "--rm",
    "--mount",
    `source=${volume},target=/data`,
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "--eval",
    `const moduleName = 'node:' + 'sqlite'; const { DatabaseSync } = await import(moduleName); const db = new DatabaseSync('/data/catalogue.sqlite', { readOnly: true }); const failure = db.prepare('SELECT id, message FROM __digital_catalogue_migration_failures').get() ?? null; const retained = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(${JSON.stringify(retainedMarker)}) !== undefined; console.log(JSON.stringify({ failure, retained })); db.close();`,
  );
  return JSON.parse(output) as {
    readonly failure: { readonly id: string; readonly message: string } | null;
    readonly retained: boolean;
  };
}

async function runDeploymentE2e(baseUrl: string): Promise<void> {
  if (process.env.DIGITAL_DEPLOYMENT_PLAYWRIGHT_CLIENT !== "container") {
    await runCommand("pnpm", ["--dir", "apps/web", "run", "test:e2e"], {
      env: { ...process.env, PLAYWRIGHT_EXTERNAL_BASE_URL: baseUrl },
      signal: abortController.signal,
      timeout: 120_000,
    });
    return;
  }
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (!browsers) {
    throw new Error(
      "PLAYWRIGHT_BROWSERS_PATH is required for container client mode",
    );
  }
  await docker(
    600_000,
    "build",
    "--pull=false",
    "--file",
    "apps/web/Dockerfile.playwright-client",
    "--tag",
    playwrightClientImage,
    ".",
  );
  const e2eOutput = await docker(
    180_000,
    "run",
    "--rm",
    "--name",
    playwrightClient,
    "--network",
    "host",
    "--mount",
    `type=bind,source=${repositoryRoot},target=/workspace`,
    "--mount",
    `type=bind,source=${browsers},target=/playwright-browsers,readonly`,
    "--workdir",
    "/workspace/apps/web",
    "-e",
    `PLAYWRIGHT_EXTERNAL_BASE_URL=${baseUrl}`,
    "-e",
    "PLAYWRIGHT_BROWSERS_PATH=/playwright-browsers",
    playwrightClientImage,
    "sh",
    "-c",
    'version=$(node node_modules/@playwright/test/cli.js --version) || exit $?; test "$version" = "Version 1.62.0" || { echo "Unexpected Playwright version: $version" >&2; exit 64; }; exec node node_modules/@playwright/test/cli.js test',
  );
  console.log(e2eOutput);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    abortController.abort(new Error(`Received ${signal}`));
  });
}

try {
  await docker(
    600_000,
    "build",
    "--pull=false",
    "--file",
    "apps/web/Dockerfile",
    "--target",
    "standalone",
    "--build-arg",
    `DEPLOYMENT_BUILD_ID=${uniqueId}`,
    "--tag",
    image,
    ".",
  );
  // A fresh standalone volume is the supported one-container deployment:
  // invoke the image with no command so its default prepare-and-start path
  // must create the baseline before Web can answer requests.
  await docker(30_000, "volume", "create", emptyStandaloneVolume);
  const emptyStandaloneBaseUrl = await launch(
    emptyStandaloneContainer,
    image,
    emptyStandaloneVolume,
  );
  await waitForReady(emptyStandaloneBaseUrl);
  await assertStatus(emptyStandaloneBaseUrl, "/api/catalogue", 200);
  await docker(30_000, "rm", "--force", emptyStandaloneContainer);

  // A migration-only invocation exits successfully and never opens HTTP.
  await docker(30_000, "volume", "create", preparedVolume);
  await docker(
    60_000,
    "run",
    "--rm",
    "--mount",
    `source=${preparedVolume},target=/data`,
    image,
    "prepare-only",
  );
  const baseUrl = await launch(container, image, preparedVolume);
  await waitForReady(baseUrl);
  const configuredUser = await docker(
    10_000,
    "image",
    "inspect",
    "--format={{.Config.User}}",
    image,
  );
  const processes = await docker(
    10_000,
    "top",
    container,
    "-eo",
    "uid,gid,pid,cmd",
  );
  if (
    !["app", "1001:1001"].includes(configuredUser) ||
    !processes
      .split("\n")
      .some((line) => /^1001\s+1001\s+\d+\s+node\b/u.test(line))
  ) {
    throw new Error(
      `Container identity must be app or 1001:1001 with a node process running as 1001:1001; image=${configuredUser}, processes=${processes}`,
    );
  }
  await runDeploymentE2e(baseUrl);

  // Stop the standalone process before starting the runtime against the same
  // prepared volume. This keeps the deployment check from ever running two
  // Web/ExecutionHost processes against one SQLite catalogue.
  await docker(30_000, "rm", "--force", container);

  await docker(
    600_000,
    "build",
    "--pull=false",
    "--file",
    "apps/web/Dockerfile",
    "--target",
    "runtime",
    "--build-arg",
    `DEPLOYMENT_BUILD_ID=${uniqueId}`,
    "--tag",
    runtimeImage,
    ".",
  );
  // The start-only target can serve a catalogue prepared by standalone, while
  // an untouched volume stays live but refuses readiness and business traffic.
  const preparedRuntime = await launch(
    runtimeContainer,
    runtimeImage,
    preparedVolume,
  );
  await waitForReady(preparedRuntime);
  await assertStatus(preparedRuntime, "/api/catalogue", 200);
  await docker(30_000, "rm", "--force", runtimeContainer);

  await docker(30_000, "volume", "create", unpreparedVolume);
  const unpreparedRuntime = await launch(
    runtimeContainer,
    runtimeImage,
    unpreparedVolume,
  );
  await assertStatus(unpreparedRuntime, "/api/ready", 503);
  await assertStatus(unpreparedRuntime, "/api/catalogue", 503);
  await docker(30_000, "rm", "--force", runtimeContainer);

  await docker(30_000, "volume", "create", futureVolume);
  await docker(
    60_000,
    "run",
    "--rm",
    "--mount",
    `source=${futureVolume},target=/data`,
    image,
    "prepare-only",
  );
  await injectLedgerFailure(
    futureVolume,
    "INSERT INTO __digital_catalogue_migrations (id, checksum, applied_at) VALUES ('99999999999999_future', 'future', '2026-08-20T00:00:00.000Z')",
  );
  const futureRuntime = await launch(
    runtimeContainer,
    runtimeImage,
    futureVolume,
  );
  await assertStatus(futureRuntime, "/api/ready", 503);
  await assertStatus(futureRuntime, "/api/catalogue", 503);
  await docker(30_000, "rm", "--force", runtimeContainer);

  await docker(30_000, "volume", "create", failedVolume);
  await docker(
    60_000,
    "run",
    "--rm",
    "--mount",
    `source=${failedVolume},target=/data`,
    image,
    "prepare-only",
  );
  await injectLedgerFailure(
    failedVolume,
    "INSERT INTO __digital_catalogue_migration_failures (id, message, occurred_at) VALUES ('20260820000000_v1_catalogue_baseline', 'failed', '2026-08-20T00:00:00.000Z')",
  );
  const failedRuntime = await launch(
    runtimeContainer,
    runtimeImage,
    failedVolume,
  );
  await assertStatus(failedRuntime, "/api/ready", 503);
  await assertStatus(failedRuntime, "/api/catalogue", 503);
  await docker(30_000, "rm", "--force", runtimeContainer);

  // Construct a catalogue that reaches the real baseline DDL and fails. The
  // standalone image must still be started with its default prepare-and-start
  // command; a runtime 503 would not prove that Web was kept offline.
  const retainedMarker = "issue17-retained-before-failed-standalone";
  const failureSecret = "issue17-secret-must-not-appear-in-diagnostics";
  await docker(30_000, "volume", "create", damagedStandaloneVolume);
  await docker(
    60_000,
    "run",
    "--rm",
    "--mount",
    `source=${damagedStandaloneVolume},target=/data`,
    image,
    "prepare-only",
  );
  await injectLedgerFailure(
    damagedStandaloneVolume,
    `INSERT INTO schema_migrations (id, applied_at) VALUES ('${retainedMarker}', '2026-08-20T00:00:00.000Z'); INSERT INTO schema_migrations (id, applied_at) VALUES ('${failureSecret}', '2026-08-20T00:00:00.000Z'); DROP INDEX workflow_executions_reuse; DELETE FROM __digital_catalogue_migrations;`,
  );
  await docker(
    30_000,
    "run",
    "--detach",
    "--name",
    damagedStandaloneContainer,
    "--mount",
    `source=${damagedStandaloneVolume},target=/data`,
    "--publish",
    "127.0.0.1::3000",
    image,
  );
  const damagedPort = await docker(
    10_000,
    "port",
    damagedStandaloneContainer,
    "3000/tcp",
  );
  const damagedPortMatch = /:(\d+)$/u.exec(damagedPort.split("\n")[0] ?? "");
  if (!damagedPortMatch?.[1])
    throw new Error(
      "Could not determine the damaged standalone published port",
    );
  const damagedBaseUrl = `http://127.0.0.1:${damagedPortMatch[1]}`;
  await waitForExit(damagedStandaloneContainer);
  await assertNotLive(damagedBaseUrl);
  const damagedLogs = await containerLogs(damagedStandaloneContainer);
  if (
    !damagedLogs.includes("生产数据库准备失败：生产迁移") ||
    damagedLogs.includes(failureSecret) ||
    /SQLITE|node:sqlite|\bat\s+/u.test(damagedLogs)
  ) {
    throw new Error(
      "Damaged standalone migration diagnostics were not sanitized",
    );
  }
  const failedMigration = await inspectFailedStandaloneMigration(
    damagedStandaloneVolume,
    retainedMarker,
  );
  if (
    failedMigration.failure?.id !== "20260820000000_v1_catalogue_baseline" ||
    failedMigration.failure.message !== "Error" ||
    !failedMigration.retained
  ) {
    throw new Error(
      "Damaged standalone migration did not retain its sanitized failure ledger and existing data",
    );
  }
} catch (error) {
  console.error(error);
  console.error(await containerLogs());
  process.exitCode = 1;
} finally {
  await cleanup();
  await assertCleanup();
}
