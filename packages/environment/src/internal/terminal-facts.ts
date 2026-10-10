import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  processIdentityProblem,
  type ProcessIdentity,
} from "./process-identity.ts";

/**
 * 记录写入失败时，本世代私有目录是唯一还带着本世代秘密、因而也唯一还能核验归属的
 * 现场。这里只保存父操作已经亲自观察到的有限事实（进程身份、真实终结、失败首因），
 * 让文件系统恢复后的下一次公开停止能在同一归属核验下收尾。它不是常驻服务、不产生
 * 新接口，也不承担任何历史迁移。
 */
export const terminalFactsFileName = "terminal-facts.json";

export type TerminalFacts = {
  readonly environmentId: string;
  readonly runId: string;
  readonly processIdentity: ProcessIdentity;
  /** 只有确认本次亲自启动的进程真实结束才写入。 */
  readonly ended?: {
    readonly at: string;
    readonly code: number | null;
    readonly signal: string | null;
  };
  readonly lastFailure: { readonly stage: string; readonly message: string };
};

export type TerminalFactsRead =
  | { readonly absent: true }
  | { readonly facts: TerminalFacts }
  | { readonly reason: string };

export function terminalFactsPath(privateDirectory: string): string {
  return path.join(privateDirectory, terminalFactsFileName);
}

/** 原子写入私有目录内的终结事实；失败只如实返回问题，不改动任何其它现场。 */
export async function writeTerminalFacts(
  privateDirectory: string,
  facts: TerminalFacts,
): Promise<string | undefined> {
  const target = terminalFactsPath(privateDirectory);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(facts, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    return undefined;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    return `终结事实未能写入本世代私有目录：${target}（${
      error instanceof Error ? error.message : "未知错误"
    }）`;
  }
}

/**
 * 读取只做准备：形状不完整或无法解析都按无效处理，绝不修复。归属由调用方按记录
 * 中的环境标识与世代标识判定。
 */
export async function readTerminalFacts(
  privateDirectory: string,
): Promise<TerminalFactsRead> {
  let text: string;
  try {
    text = await readFile(terminalFactsPath(privateDirectory), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 没有该文件是本世代从未经历记录写失败的正常状态。
    if (code === "ENOENT") return { absent: true };
    return {
      reason: `终结事实无法读取：${error instanceof Error ? error.message : "未知错误"}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "终结事实不是合法 JSON" };
  }
  const problem = terminalFactsProblem(parsed);
  return problem === undefined
    ? { facts: parsed as TerminalFacts }
    : { reason: problem };
}

function terminalFactsProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "终结事实不是对象";
  const facts = value as Record<string, unknown>;
  for (const key of ["environmentId", "runId"])
    if (typeof facts[key] !== "string" || facts[key] === "")
      return `终结事实字段 ${key} 缺失`;
  const identityProblem = processIdentityProblem(facts.processIdentity);
  if (identityProblem !== undefined)
    return `终结事实的进程身份无效：${identityProblem}`;
  const failure = facts.lastFailure;
  if (
    typeof failure !== "object" ||
    failure === null ||
    typeof (failure as Record<string, unknown>).stage !== "string" ||
    typeof (failure as Record<string, unknown>).message !== "string"
  )
    return "终结事实缺少失败首因";
  const ended = facts.ended;
  if (
    ended !== undefined &&
    (typeof ended !== "object" ||
      ended === null ||
      typeof (ended as Record<string, unknown>).at !== "string" ||
      !isExitCode((ended as Record<string, unknown>).code) ||
      !isExitSignal((ended as Record<string, unknown>).signal))
  )
    return "终结事实的退出事实不完整";
  return undefined;
}

function isExitCode(value: unknown): boolean {
  return typeof value === "number" || value === null;
}

function isExitSignal(value: unknown): boolean {
  return typeof value === "string" || value === null;
}
