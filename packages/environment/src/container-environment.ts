import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLayout } from "./internal/paths.ts";
import { filteredEnvironment } from "./internal/processes.ts";

/** Docker 命令在 daemon 所在机器执行；路径和访问地址均由调用方显式给出。 */
export type ContainerEndpoint = {
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly host: string;
};
export type ContainerReference = {
  readonly workspacePath: string;
  readonly environment: string;
};
export type ContainerMount = {
  readonly source: string;
  readonly target: string;
  readonly readonly: true;
};
export type ContainerObject = {
  readonly kind: "container" | "volume" | "network" | "image";
  readonly key: string;
  readonly name: string;
  readonly id?: string;
  readonly createdAt?: string;
  readonly state: "intent" | "present" | "absent" | "unknown";
  readonly role?: "service" | "task" | "client";
  readonly usesData?: boolean;
  readonly image?: string;
  readonly running?: boolean;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly oomKilled?: boolean;
  /** 实际 Docker stop 命令耗时；不把前后的日志保存或对账时间当作进程关闭时间。 */
  readonly stopDurationMilliseconds?: number;
  readonly health?: string;
  readonly ports?: Readonly<
    Record<string, readonly { HostIp: string; HostPort: string }[] | null>
  >;
};
export type ContainerObservation = {
  readonly environmentId: string;
  readonly managerId: string;
  readonly runId: string;
  readonly daemonId: string;
  readonly address?: string;
  readonly serviceReady: boolean;
  readonly objects: readonly ContainerObject[];
  readonly dataVolume?: string;
  readonly recordPath: string;
};
export type ContainerOperationResult = {
  readonly operation: ContainerRequest["action"];
  readonly status: "ok" | "failed" | "cancelled" | "unknown";
  readonly observation?: ContainerObservation;
  readonly failure?: { readonly stage: string; readonly message: string };
  readonly saveErrors: readonly string[];
  readonly cleanupErrors: readonly string[];
  readonly logs: readonly string[];
  readonly remaining: readonly ContainerObject[];
  readonly command?: {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly evidence?: {
    readonly directory: string;
    readonly dataSaved: boolean;
  };
};
export type ContainerRequest = ContainerReference &
  (
    | {
        readonly action: "prepare";
        readonly endpoint: ContainerEndpoint;
        readonly image: string;
        readonly mounts?: readonly ContainerMount[];
        readonly configuration?: Readonly<Record<string, string>>;
      }
    | {
        readonly action: "start";
        readonly image?: string;
        readonly role?: "service" | "task" | "client";
        readonly command?: readonly string[];
        readonly entrypoint?: string;
        readonly useData?: boolean;
        readonly dataReadonly?: boolean;
        readonly mounts?: readonly ContainerMount[];
        readonly configuration?: Readonly<Record<string, string>>;
        readonly publish?: {
          readonly hostIp: string;
          readonly hostPort: number;
          readonly containerPort: number;
        };
        readonly waitFor: "ready" | "live" | "exit" | "running";
        readonly timeoutMilliseconds?: number;
      }
    | {
        readonly action: "build";
        readonly contextPath: string;
        readonly dockerfile: string;
        readonly target?: string;
        readonly buildArguments?: Readonly<Record<string, string>>;
      }
    | { readonly action: "inspect" }
    | {
        readonly action: "wait";
        readonly objectId: string;
        readonly condition: "ready" | "live" | "exit" | "running";
        readonly timeoutMilliseconds?: number;
      }
    | {
        readonly action: "exec";
        readonly objectId: string;
        readonly command: readonly string[];
        readonly user?: string;
      }
    | {
        readonly action: "export";
        readonly objectId: string;
        readonly destination: string;
      }
    | { readonly action: "stop" }
    | {
        readonly action: "save";
        readonly directory: string;
        readonly includeData?: boolean;
      }
    | { readonly action: "delete"; readonly deleteData?: boolean }
  );

export type ContainerOperationOptions = {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
};

/**
 * 单次公共容器操作。沿既有工作区锁串行，产品不持此锁；Docker 对象始终另验实际身份。
 * 操作进程自行处理取消及收尾，调用方只转发信号并等待结构化结果。
 */
export async function manageContainerEnvironment(
  request: ContainerRequest,
  options: ContainerOperationOptions = {},
): Promise<ContainerOperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  const failed = (message: string): ContainerOperationResult => ({
    operation: request.action,
    status: "unknown",
    failure: { stage: "operation", message },
    saveErrors: [],
    cleanupErrors: [],
    logs: [],
    remaining: [],
  });
  if ("reason" in layout) return failed(layout.reason);
  await mkdir(layout.lockDirectory, { recursive: true, mode: 0o700 });
  const handle = await open(layout.lockPath, "a", 0o600);
  await handle.close();
  const extension =
    path.extname(fileURLToPath(import.meta.url)) === ".ts" ? "ts" : "js";
  const entry = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "internal",
    `container-operation-entry.${extension}`,
  );
  const child = spawn(
    "flock",
    [
      "--no-fork",
      layout.lockPath,
      process.execPath,
      entry,
      JSON.stringify({ request, deadlineAt: options.deadlineAt }),
    ],
    {
      cwd: request.workspacePath,
      env: filteredEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  const cancel = (): void => {
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const result = await new Promise<{ code: number | null; error?: string }>(
    (resolve) => {
      child.once("error", (error) =>
        resolve({ code: null, error: error.message }),
      );
      child.once("close", (code) => resolve({ code }));
    },
  );
  options.signal?.removeEventListener("abort", cancel);
  const line = stdout
    .split("\n")
    .findLast((value) => value.startsWith("DIGITAL_CONTAINER_RESULT "));
  if (line !== undefined) {
    try {
      return JSON.parse(
        line.slice("DIGITAL_CONTAINER_RESULT ".length),
      ) as ContainerOperationResult;
    } catch {
      /* 结果未能解析时保留真实退出事实。 */
    }
  }
  return failed(
    `容器操作未交出结果：exit=${String(result.code)} ${result.error ?? stderr}`,
  );
}
