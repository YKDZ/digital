import { chmod, unlink } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";

import {
  constantTimeEquals,
  controlProof,
  newNonce,
} from "./launch-contract.ts";

/** 私有控制通道只提供查询、停止与发布确认三类动作，不是公开管理接口。 */
export type ControlPhase = "handshake" | "serving" | "stopping";
export type ControlLogHealth =
  | "recording"
  | "complete"
  | "incomplete"
  | "unknown";

export type ControlState = {
  readonly phase: ControlPhase;
  readonly pid: number;
  readonly logHealth: ControlLogHealth;
  readonly logProblem?: string;
  /** 本世代是否已收到发布确认；未确认的世代只在有界预算内存活。 */
  readonly published: boolean;
};

export type ControlRequestKind = "query" | "stop" | "publish";

export type ControlReply = {
  readonly kind: ControlRequestKind;
  readonly runId: string;
  readonly state?: ControlState;
  readonly accepted?: boolean;
  readonly already?: boolean;
  readonly reason?: string;
};

const maximumLineBytes = 8_192;

type ServerInput = {
  readonly socketPath: string;
  readonly environmentId: string;
  readonly runId: string;
  readonly controlKey: string;
  readonly timeoutMilliseconds: number;
  readState(): ControlState;
  /** 目标进程向自身发出一次 SIGTERM；重复请求只观察同一关闭过程。 */
  requestSelfTerminate(): { accepted: boolean; already: boolean };
  /**
   * 发布确认只交给已经取得许可的自有世代本人：它撤销尚未发布时的自行收尾计时。
   * 准许之前或已经开始收尾的世代一律不接受。
   */
  requestPublish(): {
    readonly accepted: boolean;
    readonly already: boolean;
    readonly reason?: string;
  };
};

export type PrivateControlServer = {
  close(): Promise<void>;
};

export async function listenPrivateControl(
  input: ServerInput,
): Promise<PrivateControlServer> {
  await unlink(input.socketPath).catch(() => undefined);
  const server = createServer((socket) => {
    void serveConnection(socket, input);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: input.socketPath }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(input.socketPath, 0o600).catch(() => undefined);
  return {
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * 单连接一轮问答：服务端先给出一次性挑战，客户端用该挑战计算凭据证明，因此重放
 * 旧消息不能通过；环境身份与本世代 runId 不符时同样拒绝。
 */
async function serveConnection(
  socket: Socket,
  input: ServerInput,
): Promise<void> {
  socket.setEncoding("utf8");
  const deadline = setTimeout(
    () => socket.destroy(),
    input.timeoutMilliseconds,
  );
  try {
    const nonce = newNonce();
    socket.write(`${JSON.stringify({ t: "challenge", nonce })}\n`);
    const line = await readLine(socket);
    if (line === null) return;
    const message = parseObject(line);
    const kind = message?.kind;
    if (
      message?.t !== "request" ||
      (kind !== "query" && kind !== "stop" && kind !== "publish") ||
      message.environmentId !== input.environmentId ||
      message.nonce !== nonce ||
      typeof message.proof !== "string"
    ) {
      socket.write(
        `${JSON.stringify({ t: "refused", reason: "控制请求形状无效" })}\n`,
      );
      return;
    }
    if (
      !constantTimeEquals(
        controlProof(input.controlKey, kind, input.runId, nonce),
        message.proof,
      )
    ) {
      socket.write(
        `${JSON.stringify({ t: "refused", reason: "控制凭据不成立" })}\n`,
      );
      return;
    }
    if (kind === "query") {
      socket.write(
        `${JSON.stringify({
          t: "response",
          kind: "query",
          runId: input.runId,
          state: input.readState(),
        })}\n`,
      );
      return;
    }
    if (kind === "publish") {
      const publication = input.requestPublish();
      socket.write(
        `${JSON.stringify({
          t: "response",
          kind: "publish",
          runId: input.runId,
          accepted: publication.accepted,
          already: publication.already,
          ...(publication.reason === undefined
            ? {}
            : { reason: publication.reason }),
          state: input.readState(),
        })}\n`,
      );
      return;
    }
    const termination = input.requestSelfTerminate();
    socket.write(
      `${JSON.stringify({
        t: "response",
        kind: "stop",
        runId: input.runId,
        accepted: termination.accepted,
        already: termination.already,
      })}\n`,
    );
  } finally {
    clearTimeout(deadline);
    socket.end();
  }
}

export async function requestPrivateControl(input: {
  readonly socketPath: string;
  readonly environmentId: string;
  readonly runId: string;
  readonly controlKey: string;
  readonly kind: ControlRequestKind;
  readonly timeoutMilliseconds: number;
}): Promise<{ readonly reply: ControlReply } | { readonly reason: string }> {
  const socket = connect({ path: input.socketPath });
  socket.setEncoding("utf8");
  socket.setTimeout(input.timeoutMilliseconds);
  try {
    const failure = await new Promise<string | undefined>((resolve) => {
      socket.once("error", (error) =>
        resolve(`控制通道连接失败：${error.message}`),
      );
      socket.once("timeout", () => resolve("控制通道连接超时"));
      socket.once("connect", () => resolve(undefined));
    });
    if (failure !== undefined) return { reason: failure };
    const challenge = await readLine(socket);
    if (challenge === null) return { reason: "控制通道没有交出挑战" };
    const challengeMessage = parseObject(challenge);
    if (
      challengeMessage?.t !== "challenge" ||
      typeof challengeMessage.nonce !== "string"
    )
      return { reason: "控制通道挑战无效" };
    const nonce = challengeMessage.nonce;
    socket.write(
      `${JSON.stringify({
        t: "request",
        kind: input.kind,
        environmentId: input.environmentId,
        nonce,
        proof: controlProof(input.controlKey, input.kind, input.runId, nonce),
      })}\n`,
    );
    const line = await readLine(socket);
    if (line === null) return { reason: "控制通道没有交出响应" };
    const message = parseObject(line);
    if (message?.t === "refused")
      return {
        reason: `控制通道拒绝请求：${
          typeof message.reason === "string" && message.reason.length > 0
            ? message.reason
            : "原因未说明"
        }`,
      };
    if (
      message?.t !== "response" ||
      message.kind !== input.kind ||
      message.runId !== input.runId
    )
      return { reason: "控制通道响应与本世代不一致" };
    return { reply: message as unknown as ControlReply };
  } finally {
    socket.destroy();
  }
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 只取第一行；超限、关闭或出错都返回 null，由调用方如实报告不可确认。 */
function readLine(socket: Socket): Promise<string | null> {
  return new Promise((resolve) => {
    let buffered = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      socket.removeListener("data", onData);
      resolve(value);
    };
    function onData(chunk: string | Buffer): void {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(buffered) > maximumLineBytes) {
        finish(null);
        return;
      }
      const index = buffered.indexOf("\n");
      if (index < 0) return;
      finish(buffered.slice(0, index));
    }
    socket.on("data", onData);
    socket.once("end", () => finish(null));
    socket.once("close", () => finish(null));
    socket.once("error", () => finish(null));
    socket.once("timeout", () => finish(null));
  });
}
