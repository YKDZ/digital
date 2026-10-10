import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createLaunchConfig,
  handoffMarkerTag,
  launchConfigEnvironmentVariable,
  writeLaunchConfig,
  type LaunchConfig,
} from "../src/internal/launch-contract.ts";
import {
  requestPrivateControl,
  type ControlState,
} from "../src/internal/private-control.ts";

const packageRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
);
/** 外层引导由产品进程用 `node --import` 加载，因此取正式构建产物。 */
const guideEntry = path.join(packageRoot, "dist", "internal", "web-guide.js");
const guideTimeoutMilliseconds = 30_000;

const temporaryDirectories: string[] = [];
const startedChildren: ChildProcess[] = [];

/** 本回合合成凭据样式值；断言只关心它们是否出现在任何输出里。 */
const bearerValue = "token-9d1c";
const cookieValue = "session-value-7e3b";
const syntheticSecrets = [bearerValue, cookieValue];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function delay(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
}

type Booted = {
  readonly child: ChildProcess;
  readonly config: LaunchConfig;
  readonly entryMarker: string;
  admit(): void;
  refuse(reason: string): void;
  takeMessage(type: string): Promise<Record<string, unknown>>;
  pipeText(): string;
  readLog(): Promise<string>;
  waitFor(callback: () => Promise<boolean>): Promise<boolean>;
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

/**
 * 以父操作身份启动外层引导：只消费两条双流交接标记与身份提交，其余继承管道都归本
 * 回合自有句柄，收尾时全部销毁，不留悬挂进程。
 */
async function bootGuide(input: {
  readonly fixture: string;
  readonly productLogFile?: string;
}): Promise<Booted> {
  const directory = await temporaryDirectory("digital-02-guide-");
  await chmod(directory, 0o700);
  const config = createLaunchConfig({
    environmentId: "t02-guide",
    runId: randomUUID(),
    controlSocket: path.join(directory, "control.sock"),
    productLogFile: input.productLogFile ?? path.join(directory, "product.log"),
    publishDeadlineAt: Date.now() + 240_000,
  });
  const launchConfigFile = path.join(directory, "launch.json");
  await writeLaunchConfig(launchConfigFile, config);
  const entryMarker = path.join(directory, "entry-loaded");
  const fixturePath = path.join(directory, "fixture-entry.mjs");
  await writeFile(
    fixturePath,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(entryMarker)}, "loaded");
${input.fixture}
`,
  );

  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(guideEntry).href, fixturePath],
    {
      cwd: packageRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        [launchConfigEnvironmentVariable]: launchConfigFile,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  startedChildren.push(child);

  // 交接标记是各自流上的第一行；取走之后剩下的管道文本才代表产品的持久出口。
  const pipes: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  const markers: Record<"stdout" | "stderr", boolean> = {
    stdout: false,
    stderr: false,
  };
  for (const name of ["stdout", "stderr"] as const) {
    const stream = child[name];
    const expected = `${handoffMarkerTag} ${config.handoff[name]}`;
    if (stream === null || stream === undefined) continue;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      pipes[name] += chunk;
      if (markers[name]) return;
      const lineEnd = pipes[name].indexOf("\n");
      if (lineEnd < 0) return;
      if (pipes[name].slice(0, lineEnd) === expected) {
        markers[name] = true;
        pipes[name] = pipes[name].slice(lineEnd + 1);
      } else {
        markers[name] = true;
      }
    });
  }

  const messages: Record<string, unknown>[] = [];
  child.on("message", (message: Record<string, unknown>) => {
    messages.push(message);
  });
  const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
  child.on("exit", (code, signal) => {
    exits.push({ code, signal });
  });

  return {
    child,
    config,
    entryMarker,
    admit: () => {
      child.send({ type: "admit", runId: config.runId });
    },
    refuse: (reason: string) => {
      child.send({ type: "refuse", runId: config.runId, reason });
    },
    takeMessage: async (type: string) => {
      const deadline = Date.now() + guideTimeoutMilliseconds;
      for (;;) {
        const index = messages.findIndex((message) => message.type === type);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        if (Date.now() >= deadline)
          throw new Error(`没有收到本世代引导的 ${type} 提交`);
        await delay();
      }
    },
    pipeText: () => `${pipes.stdout}${pipes.stderr}`,
    readLog: () => readFile(config.productLogFile, "utf8").catch(() => ""),
    waitFor: async (callback: () => Promise<boolean>) => {
      const deadline = Date.now() + guideTimeoutMilliseconds;
      for (;;) {
        if (await callback()) return true;
        if (Date.now() >= deadline) return false;
        await delay();
      }
    },
    exited: () =>
      new Promise((resolve) => {
        const first = exits[0];
        if (first !== undefined) {
          resolve(first);
          return;
        }
        child.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      }),
  };
}

async function queryState(
  booted: Booted,
  kind: "query" | "stop",
): Promise<ControlState | undefined> {
  const result = await requestPrivateControl({
    socketPath: booted.config.controlSocket,
    environmentId: booted.config.environmentId,
    runId: booted.config.runId,
    controlKey: booted.config.controlKey,
    kind,
    timeoutMilliseconds: 5_000,
  });
  return "reply" in result ? result.reply.state : undefined;
}

afterAll(async () => {
  // 只收尾本回合亲自启动的引导进程，之后删除自有临时目录。
  for (const child of startedChildren) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    if (child.connected) child.disconnect();
  }
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
});

describe("外层引导持有本世代运行日志", () => {
  beforeAll(async () => {
    expect(await exists(guideEntry)).toBe(true);
  });

  it(
    "双流都完整脱敏后同步落盘，继承管道只剩交接标记，控制通道如实报告阶段",
    async () => {
      const booted = await bootGuide({
        fixture: [
          `process.stdout.write("Authorization: Bearer chunked-");`,
          `setTimeout(() => { process.stdout.write(${JSON.stringify(`${bearerValue}\n`)}); }, 60);`,
          `process.stderr.write("Cookie: session=${cookieValue}\\n");`,
          // 收尾沿用产品既有生命周期：产品自己接住 SIGTERM，引导不代替它退出。
          'process.on("SIGTERM", () => {',
          '  process.stdout.write("产品自行收尾\\n");',
          "  process.exit(0);",
          "});",
          "setInterval(() => {}, 500);",
        ].join("\n"),
      });
      const sinks = await booted.takeMessage("sinks-ready");
      expect(sinks.runId).toBe(booted.config.runId);
      const identity = await booted.takeMessage("identity");
      expect(identity.pid).toBe(booted.child.pid);
      expect(identity.controlSocket).toBe(booted.config.controlSocket);
      expect(identity.identity).toBeTypeOf("object");

      booted.admit();
      expect(
        await booted.waitFor(async () => await exists(booted.entryMarker)),
      ).toBe(true);
      const recorded = await booted.waitFor(async () => {
        const text = await booted.readLog();
        return text.includes("Authorization:") && text.includes("Cookie:");
      });
      expect(recorded).toBe(true);
      const log = await booted.readLog();
      expect(log).toContain("Authorization: [REDACTED]");
      expect(log).toContain("Cookie: [REDACTED]");
      expect(log).toContain("已取得进入正式入口的许可");

      // 每条产品输出各占一条记录：记录前缀的个数必须与物理行数一致，否则说明有
      // 两条记录被拼接到了同一行上，破坏日志的行语义。
      const prefix =
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (out|err|run|exit) /gu;
      expect(log).toMatch(/\n$/u);
      expect((log.match(prefix) ?? []).length).toBe(
        log.replace(/\n$/u, "").split("\n").length,
      );

      // 标记之后的管道文本必须为空：产品输出没有绕过接收端的持久出口。
      const pipe = booted.pipeText();
      const leaks = syntheticSecrets.some(
        (secret) => pipe.includes(secret) || log.includes(secret),
      );
      expect(leaks).toBe(false);
      expect(pipe).toBe("");

      let state: ControlState | undefined;
      const serving = await booted.waitFor(async () => {
        state = await queryState(booted, "query");
        return state?.phase === "serving";
      });
      expect(serving).toBe(true);
      expect(state?.pid).toBe(booted.child.pid);
      expect(state?.logHealth).toBe("recording");

      await requestPrivateControl({
        socketPath: booted.config.controlSocket,
        environmentId: booted.config.environmentId,
        runId: booted.config.runId,
        controlKey: booted.config.controlKey,
        kind: "stop",
        timeoutMilliseconds: 5_000,
      });
      expect((await booted.exited()).code).toBe(0);
      const finalLog = await booted.readLog();
      expect(finalLog).toContain("产品自行收尾");
      // 收尾健康先定事实再落盘，日志文件与控制回音不会互相矛盾。
      expect(finalLog).toContain("运行日志收尾 health=complete");
    },
    guideTimeoutMilliseconds * 3,
  );

  it(
    "未捕获异常只被记录，不接管：进程仍按 Node 默认退出，诊断留在日志里",
    async () => {
      const booted = await bootGuide({
        fixture: [
          'process.stdout.write("引导后的普通输出\\n");',
          'setTimeout(() => { throw new Error("未捕获诊断 probe-1b2c"); }, 120);',
          "setInterval(() => {}, 500);",
        ].join("\n"),
      });
      await booted.takeMessage("identity");
      booted.admit();
      expect((await booted.exited()).code).toBe(1);
      const log = await booted.readLog();
      expect(log).toContain("未捕获异常");
      expect(log).toContain("未捕获诊断 probe-1b2c");
      expect(log).toContain("引导后的普通输出");
    },
    guideTimeoutMilliseconds * 3,
  );

  it(
    "父操作不准许时产品入口根本不加载，引导只收尾自己的握手",
    async () => {
      const booted = await bootGuide({
        fixture: [
          'process.stdout.write("产品输出，不该出现\\n");',
          "setInterval(() => {}, 500);",
        ].join("\n"),
      });
      await booted.takeMessage("identity");
      booted.refuse("就绪认证未成立");
      expect((await booted.exited()).code).toBe(1);
      expect(await exists(booted.entryMarker)).toBe(false);
      const log = await booted.readLog();
      expect(log).toContain("父操作不准许进入产品");
      expect(log).toContain("就绪认证未成立");
      expect(booted.pipeText()).not.toContain("产品输出");
    },
    guideTimeoutMilliseconds * 3,
  );

  it(
    "日志写入被文件系统拒绝时如实报告不完整，不影响本世代继续服务与停止",
    async () => {
      const booted = await bootGuide({
        fixture: [
          'process.stdout.write("仍要继续服务的输出\\n");',
          "setInterval(() => {}, 500);",
        ].join("\n"),
        productLogFile: "/dev/full",
      });
      await booted.takeMessage("identity");
      booted.admit();
      let state: ControlState | undefined;
      const reported = await booted.waitFor(async () => {
        state = await queryState(booted, "query");
        return (
          state?.logHealth === "incomplete" &&
          (state?.logProblem ?? "").includes("运行日志写入被拒绝")
        );
      });
      expect(reported).toBe(true);
      await requestPrivateControl({
        socketPath: booted.config.controlSocket,
        environmentId: booted.config.environmentId,
        runId: booted.config.runId,
        controlKey: booted.config.controlKey,
        kind: "stop",
        timeoutMilliseconds: 5_000,
      });
      expect((await booted.exited()).signal).toBe("SIGTERM");
    },
    guideTimeoutMilliseconds * 3,
  );
});
